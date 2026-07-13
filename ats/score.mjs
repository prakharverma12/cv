#!/usr/bin/env node
// Local ATS / resume scorer for index.html.
//
// What it does:
//   1. Extracts the résumé text (parse-fidelity: what an ATS's text layer sees).
//   2. Scores that text against each role JD in ./roles/*.md using Claude, with a
//      structured rubric: skills match, seniority fit, quantified impact, keyword
//      coverage — plus present/missing keywords and concrete suggestions.
//
// Usage:
//   node score.mjs                      # score against every role in ./roles/
//   node score.mjs backend-engineer     # score against one role (by filename stem)
//   node score.mjs --pdf ../resume.pdf  # score the extracted text of a real PDF (needs pdftotext)
//   node score.mjs --print-resume       # just print the extracted résumé text and exit
//
// Auth: set ANTHROPIC_API_KEY, or run `ant auth login` (the SDK auto-resolves creds).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL = "claude-opus-4-8";

// ---------- résumé text extraction ----------

// Strip the HTML résumé down to clean reading-order text — the same content-stream
// order an ATS's text layer sees. Drops the invisible cv-bridge spacer glyphs.
function extractResumeFromHtml(htmlPath) {
  let html = fs.readFileSync(htmlPath, "utf8");

  // Keep only the résumé <article>, if present.
  const art = html.match(/<article[^>]*id=["']resume["'][^>]*>([\s\S]*?)<\/article>/i);
  if (art) html = art[1];

  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // drop the invisible bridge spacers entirely
    .replace(/<span class=["']cv-bridge["'][^>]*>[\s\S]*?<\/span>/gi, " ")
    // list items / block ends → newline so bullets stay separate lines
    .replace(/<\/(li|p|div|h[1-6]|section|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    // decode the handful of entities this résumé uses
    .replace(/&nbsp;/gi, " ")
    .replace(/&emsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&le;/gi, "≤")
    .replace(/&#8195;/g, " ")
    .replace(/[ \t  ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n")
    .trim();
}

function extractResumeFromPdf(pdfPath) {
  try {
    // -raw = content-stream order (what most ATS libraries read); clean & sequential.
    return execFileSync("pdftotext", ["-raw", pdfPath, "-"], { encoding: "utf8" }).trim();
  } catch (e) {
    console.error(`Could not run pdftotext on ${pdfPath}: ${e.message}`);
    console.error("Install poppler (provides pdftotext), or omit --pdf to score index.html.");
    process.exit(1);
  }
}

// ---------- rubric scoring ----------

const RUBRIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overall_score: { type: "integer", description: "0-100 overall fit for this role" },
    skills_match: { type: "integer", description: "0-10: required skills present in the résumé" },
    seniority_fit: { type: "integer", description: "0-10: experience level vs what the role expects" },
    quantified_impact: { type: "integer", description: "0-10: measurable, credible impact in bullets" },
    keyword_coverage: { type: "integer", description: "0-10: JD keywords/tools literally present (ATS keyword match)" },
    present_keywords: { type: "array", items: { type: "string" }, description: "Important JD keywords found in the résumé" },
    missing_keywords: { type: "array", items: { type: "string" }, description: "Important JD keywords/skills absent from the résumé" },
    verdict: { type: "string", description: "1-2 sentence overall assessment for this role" },
    top_suggestions: { type: "array", items: { type: "string" }, description: "3-5 concrete, honest edits to raise the score — only skills/keywords the candidate plausibly already has" },
  },
  required: [
    "overall_score", "skills_match", "seniority_fit", "quantified_impact",
    "keyword_coverage", "present_keywords", "missing_keywords", "verdict", "top_suggestions",
  ],
};

const SYSTEM = `You are a rigorous but fair technical recruiter and ATS analyst.
You are scoring a real candidate's résumé against a specific job description, the way a
modern applicant-tracking system plus a hiring manager would.

Rules:
- Score honestly. Do not inflate. A résumé missing core required skills should score low on skills_match and keyword_coverage.
- keyword_coverage is literal: does the JD's key term appear (or an obvious synonym) in the résumé text? This mirrors ATS keyword matching.
- missing_keywords must be real gaps from THIS JD, not generic filler.
- top_suggestions must be truthful: only recommend surfacing skills/keywords the candidate plausibly already has based on their experience. NEVER suggest fabricating experience or hiding keywords.
- Return only the structured object.`;

function buildUserPrompt(roleName, jd, resume) {
  return `ROLE: ${roleName}

=== JOB DESCRIPTION ===
${jd}

=== CANDIDATE RÉSUMÉ (extracted text, as an ATS would read it) ===
${resume}

Score this résumé against the job description above.`;
}

async function scoreRole(client, roleName, jd, resume) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: RUBRIC_SCHEMA } },
    messages: [{ role: "user", content: buildUserPrompt(roleName, jd, resume) }],
  });
  const text = resp.content.find((b) => b.type === "text")?.text ?? "{}";
  return JSON.parse(text);
}

// ---------- presentation ----------

function bar(n, max) {
  const filled = Math.round((n / max) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function printResult(roleName, r) {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  ${roleName}   —   OVERALL ${r.overall_score}/100`);
  console.log("═".repeat(64));
  const rows = [
    ["Skills match", r.skills_match],
    ["Seniority fit", r.seniority_fit],
    ["Quantified impact", r.quantified_impact],
    ["Keyword coverage", r.keyword_coverage],
  ];
  for (const [label, val] of rows) {
    console.log(`  ${label.padEnd(20)} ${bar(val, 10)} ${val}/10`);
  }
  console.log(`\n  Verdict: ${r.verdict}`);
  if (r.present_keywords?.length) console.log(`\n  Present : ${r.present_keywords.join(", ")}`);
  if (r.missing_keywords?.length) console.log(`  Missing : ${r.missing_keywords.join(", ")}`);
  if (r.top_suggestions?.length) {
    console.log(`\n  Suggestions:`);
    for (const s of r.top_suggestions) console.log(`    • ${s}`);
  }
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  const pdfIdx = args.indexOf("--pdf");
  let resume;
  if (pdfIdx !== -1) {
    resume = extractResumeFromPdf(args[pdfIdx + 1]);
    args.splice(pdfIdx, 2);
  } else {
    resume = extractResumeFromHtml(path.join(HERE, "..", "index.html"));
  }

  if (args.includes("--print-resume")) {
    console.log(resume);
    return;
  }

  const rolesDir = path.join(HERE, "roles");
  let roleFiles = fs.readdirSync(rolesDir).filter((f) => f.endsWith(".md"));
  const only = args.find((a) => !a.startsWith("--"));
  if (only) {
    const match = roleFiles.find((f) => f.replace(/\.md$/, "") === only);
    if (!match) {
      console.error(`No role "${only}". Available: ${roleFiles.map((f) => f.replace(/\.md$/, "")).join(", ")}`);
      process.exit(1);
    }
    roleFiles = [match];
  }

  let client;
  try {
    client = new Anthropic(); // resolves ANTHROPIC_API_KEY or an `ant auth login` profile
  } catch (e) {
    console.error("Could not initialize the Anthropic client:", e.message);
    process.exit(1);
  }

  console.log(`Scoring résumé (${resume.length} chars) against ${roleFiles.length} role(s) with ${MODEL}…`);

  const summary = [];
  for (const file of roleFiles) {
    const roleName = file.replace(/\.md$/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const jd = fs.readFileSync(path.join(rolesDir, file), "utf8");
    try {
      const r = await scoreRole(client, roleName, jd, resume);
      printResult(roleName, r);
      summary.push([roleName, r.overall_score]);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) {
        console.error("\nAuthentication failed. Set ANTHROPIC_API_KEY or run `ant auth login`.");
        process.exit(1);
      }
      console.error(`\n${roleName}: scoring failed — ${e.message}`);
    }
  }

  if (summary.length > 1) {
    console.log(`\n${"═".repeat(64)}\n  SUMMARY (best fit first)\n${"═".repeat(64)}`);
    for (const [role, score] of summary.sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(score).padStart(3)}/100   ${role}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
