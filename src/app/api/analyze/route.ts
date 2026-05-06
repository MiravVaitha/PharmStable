import { NextRequest, NextResponse } from "next/server";
import { calculateStability } from "@/lib/stability/algorithm";
import type { StabilityInput } from "@/lib/stability/types";
import { getAuthedUserId } from "@/lib/apiAuth";
import { ipFromRequest, keyForRequest, rateLimit } from "@/lib/rateLimit";

const LIMIT = 30;
const WINDOW_MS = 60_000;
// Cheap pre-auth IP throttle so unauthenticated floods don't get to do a
// Supabase auth lookup on every request.
const PREAUTH_LIMIT = 60;
const PREAUTH_WINDOW_MS = 60_000;

const MAX_DRUG_NAME = 200;
const MAX_SMILES = 500;
const MAX_FREEFORM = 2000;

/**
 * POST /api/analyze
 * Runs the heuristic stability algorithm. No external calls, but still
 * worth gating with auth + rate limit so it can't be used as a free
 * compute oracle or as a stepping stone to flood other endpoints.
 */
export async function POST(req: NextRequest) {
  const ipRl = rateLimit(
    `analyze:ip:${ipFromRequest(req)}`,
    PREAUTH_LIMIT,
    PREAUTH_WINDOW_MS
  );
  if (!ipRl.ok) {
    return NextResponse.json(
      { error: `Rate limit exceeded. Try again in ${ipRl.retryAfterSec}s.` },
      {
        status: 429,
        headers: { "Retry-After": String(ipRl.retryAfterSec) },
      }
    );
  }

  const userId = await getAuthedUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 }
    );
  }

  const rl = rateLimit(`analyze:${keyForRequest(req, userId)}`, LIMIT, WINDOW_MS);
  if (!rl.ok) {
    return NextResponse.json(
      {
        error: `Rate limit exceeded. Try again in ${rl.retryAfterSec}s.`,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rl.retryAfterSec),
          "X-RateLimit-Limit": String(rl.limit),
          "X-RateLimit-Remaining": "0",
        },
      }
    );
  }

  try {
    const body = await req.json();

    // ── Input validation ──────────────────────────────────────────
    if (typeof body?.drugName !== "string" || !body.drugName.trim()) {
      return NextResponse.json(
        { error: "Drug name is required." },
        { status: 400 }
      );
    }
    if (body.drugName.length > MAX_DRUG_NAME) {
      return NextResponse.json(
        { error: `Drug name must be ${MAX_DRUG_NAME} characters or less.` },
        { status: 400 }
      );
    }
    if (!body.expiryDate) {
      return NextResponse.json(
        { error: "Expiry date is required." },
        { status: 400 }
      );
    }
    if (!body.formulation) {
      return NextResponse.json(
        { error: "Formulation type is required." },
        { status: 400 }
      );
    }
    if (
      body.smiles !== undefined &&
      (typeof body.smiles !== "string" || body.smiles.length > MAX_SMILES)
    ) {
      return NextResponse.json(
        { error: `SMILES must be ${MAX_SMILES} characters or less.` },
        { status: 400 }
      );
    }

    const input: StabilityInput = {
      drugName: body.drugName,
      smiles: typeof body.smiles === "string" ? body.smiles : "",
      stabilityClass: body.stabilityClass || 3,
      formulation: body.formulation,
      expiryDate: body.expiryDate,
      manufacturingDate: body.manufacturingDate,
      storageTemp: body.storageTemp ?? 25,
      storageHumidity: body.storageHumidity ?? 60,
      lightExposure: body.lightExposure || "none",
      containerIntegrity: body.containerIntegrity || "sealed",
      strength:
        typeof body.strength === "string"
          ? body.strength.slice(0, MAX_FREEFORM)
          : undefined,
      manufacturer:
        typeof body.manufacturer === "string"
          ? body.manufacturer.slice(0, MAX_FREEFORM)
          : undefined,
      notes:
        typeof body.notes === "string"
          ? body.notes.slice(0, MAX_FREEFORM)
          : undefined,
    };

    const result = calculateStability(input);

    return NextResponse.json(result, {
      headers: {
        "X-RateLimit-Limit": String(rl.limit),
        "X-RateLimit-Remaining": String(rl.remaining),
      },
    });
  } catch (err) {
    console.error("Analysis error:", err);
    return NextResponse.json(
      { error: "Internal server error during analysis." },
      { status: 500 }
    );
  }
}
