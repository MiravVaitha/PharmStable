import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildSystemPrompt,
  buildUserPrompt,
  parseDiscoveryResponse,
} from "@/lib/claude/discovery";
import type { StabilityResult } from "@/lib/stability/types";
import { getAuthedUserId } from "@/lib/apiAuth";
import { ipFromRequest, keyForRequest, rateLimit } from "@/lib/rateLimit";

// AI calls are expensive (latency + $$). Keep this tight.
const LIMIT = 10;
const WINDOW_MS = 60_000; // 1 min
// Cheap pre-auth IP throttle so unauthenticated floods don't get to do a
// Supabase auth lookup on every request.
const PREAUTH_LIMIT = 30;
const PREAUTH_WINDOW_MS = 60_000;

// Bounds on user-controlled prompt inputs to keep request size predictable
// and reduce prompt-injection / token-bomb surface.
const MAX_DRUG_NAME = 200;
const MAX_SMILES = 500;

/**
 * POST /api/discover
 * Auth-gated, rate-limited Claude call that turns a stability result into
 * drug repurposing suggestions.
 *
 * Hardening:
 *   - Requires a Supabase session.
 *   - Rate limited (sliding window, in-memory).
 *   - The Anthropic API key is read ONLY from the server environment.
 *     Any apiKey field on the request body is ignored.
 *   - Input length bounds.
 *   - Errors are sanitized so internal details never leak to the client.
 */
export async function POST(req: NextRequest) {
  // ── Pre-auth IP throttle ─────────────────────────────────────────
  const ipRl = rateLimit(
    `discover:ip:${ipFromRequest(req)}`,
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

  // ── Auth ──────────────────────────────────────────────────────────
  const userId = await getAuthedUserId();
  if (!userId) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 }
    );
  }

  // ── Rate limit ───────────────────────────────────────────────────
  const rl = rateLimit(`discover:${keyForRequest(req, userId)}`, LIMIT, WINDOW_MS);
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

    const {
      drugName,
      smiles,
      stabilityResult,
    }: {
      drugName?: unknown;
      smiles?: unknown;
      stabilityResult?: StabilityResult;
    } = body ?? {};

    // ── Input validation ──────────────────────────────────────────
    if (typeof drugName !== "string" || !drugName.trim()) {
      return NextResponse.json(
        { error: "Drug name is required." },
        { status: 400 }
      );
    }
    if (drugName.length > MAX_DRUG_NAME) {
      return NextResponse.json(
        { error: `Drug name must be ${MAX_DRUG_NAME} characters or less.` },
        { status: 400 }
      );
    }
    if (smiles !== undefined && typeof smiles !== "string") {
      return NextResponse.json(
        { error: "SMILES must be a string." },
        { status: 400 }
      );
    }
    const safeSmiles = typeof smiles === "string" ? smiles.slice(0, MAX_SMILES) : "";

    if (
      !stabilityResult ||
      typeof stabilityResult !== "object" ||
      typeof (stabilityResult as any).probability !== "number"
    ) {
      return NextResponse.json(
        { error: "Valid stability result is required." },
        { status: 400 }
      );
    }

    // ── API key (server only) ─────────────────────────────────────
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey?.startsWith("sk-ant-")) {
      // Don't leak which env var is missing or its shape.
      return NextResponse.json(
        { error: "AI discovery is not configured on this server." },
        { status: 503 }
      );
    }

    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      system: buildSystemPrompt(),
      messages: [
        {
          role: "user",
          content: buildUserPrompt(drugName, safeSmiles, stabilityResult),
        },
      ],
    });

    const responseText = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");

    const discovery = parseDiscoveryResponse(responseText);

    return NextResponse.json(discovery, {
      headers: {
        "X-RateLimit-Limit": String(rl.limit),
        "X-RateLimit-Remaining": String(rl.remaining),
      },
    });
  } catch (err) {
    // Log full error server-side for debugging; return a generic message
    // to the client so we don't leak Anthropic / runtime internals.
    console.error("Discovery error:", err);

    if (err instanceof Anthropic.APIError) {
      // 4xx from Anthropic typically means our request was malformed; surface
      // a generic 502 (upstream error) rather than echoing their message.
      return NextResponse.json(
        { error: "AI provider returned an error." },
        { status: 502 }
      );
    }

    return NextResponse.json(
      { error: "Failed to generate discovery suggestions." },
      { status: 500 }
    );
  }
}
