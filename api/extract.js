/* ============================================================
   VERCEL SERVERLESS FUNCTION · Proposal extraction via Claude
   ------------------------------------------------------------
   Path: /api/extract

   Reads a proposal (plain text and/or page images) and returns a
   structured extraction PLUS a short human narrative ("the story").
   The Anthropic API key lives only here as an env var — never in the
   browser.

   SETUP (Vercel → Settings → Environment Variables)
     ANTHROPIC_API_KEY = sk-ant-...           (required)
     CLAUDE_MODEL      = claude-sonnet-4-6   (optional; override if needed)

   REQUEST  (POST JSON)
     { text?: string, images?: ["data:image/png;base64,...", ...] }
   RESPONSE (JSON)
     { narrative, project, phases, people }   // see SCHEMA in the prompt
   ============================================================ */

const SYSTEM = `You are an expert at reading professional-services FEE PROPOSALS and FEE MATRICES (project & program management, change management, relocation, workplace) and turning them into structured data. You are precise with money, dates, durations, and people. You never invent numbers; if something isn't stated, you use null.`;

// Allow larger JSON bodies (page images) up to Vercel's ceiling.
export const config = { api: { bodyParser: { sizeLimit: '4.5mb' } } };

function buildPrompt() {
  return `Read the attached proposal / fee matrix and extract it. Return ONLY minified JSON (no prose, no code fence) with EXACTLY this shape:

CRITICAL — ANTI-FABRICATION (highest priority):
- Extract ONLY values that are EXPLICITLY VISIBLE in the document. If a value is not clearly shown, return null. NEVER estimate, infer, guess, average, or fill a gap. Many fields being null is CORRECT and expected.
- A proposal's COVER/SIGNATURE DATE is NOT the project start date. Only set startDate/endDate if an actual project term/schedule is shown.
- Do NOT invent phase durations, an even split, or a 12-month default. If durations aren't shown, leave weeks null.
- Only include people whose names are actually printed. Do NOT add placeholder team members.
- If you are unsure whether something is the fee vs. a budget vs. a rate, leave it null rather than risk a wrong number.
- It is far better to return null than a plausible-but-unverified value. Accuracy over completeness, always.

{
 "narrative": string,            // 2-4 plain sentences. Tell the story from ONLY what's shown: client & project, the period IF stated, headcount, team structure, total fee IF stated, billing. EXPLICITLY say which of {period, durations, fee, rates} are NOT stated in the document. Never imply a value you didn't extract.
 "project": {
   "name": string,
   "client": string,
   "startDate": "MON YYYY"|null,
   "endDate": "MON YYYY"|null,
   "totalFee": number|null,       // the headline contract/proposal fee in USD
   "oneTimeDiscount": number|null,// any one-time/lump discount in USD
   "billing": "flat"|"phase"|null // "flat" = a fixed equal monthly fee for the whole term; else "phase"
 },
 "phases": [
   { "name": string, "weeks": number|null, "startDate":"MON YYYY"|null, "endDate":"MON YYYY"|null, "fee": number|null }
 ],
 "people": [
   { "name": string, "staffTitle": string, "projectRole": string, "team": string, "allocation": number, "rate": number|null }
 ]
}

RULES:
- READ EVERY PAGE. Proposals bury the schedule and fee on later pages — look for a "Project Schedule", "Timeline", "Phasing", "Gantt", "Term", or "Fee" page anywhere in the document, not just the first pages.
- phases = the actual TIME-PHASED PROJECT SCHEDULE, not the scope-of-services outline. A scope list ("Pre-Construction, Construction, Closeout" as service descriptions) is NOT a schedule unless durations or a timeline bar are shown. If you see a Gantt/timeline bar chart, read each phase's span and convert it to a duration in WEEKS (estimate from the bar length against the month/quarter axis). If the proposal gives a project TERM or DURATION (e.g. "12-month engagement", "Q1 2026 – Q4 2026") use it to set startDate/endDate and to size phases.
- DO NOT FABRICATE. If start/end dates or phase durations are NOT shown, set them to null — never invent an even split or a placeholder year. A wrong schedule is worse than a null one.
- BUDGET ≠ FEE. A "project budget" / "construction budget" / "project cost" (e.g. "$8.2MM project") is the cost of the WORK, NOT Macro's fee. Never put a construction/project budget in totalFee. totalFee is ONLY Macro's/Savills' professional-services fee. If the fee is a % of project cost, capture the % in narrative but leave totalFee null unless the dollar fee is explicitly stated.
- people = the staffing roster / fee matrix rows. allocation is a DECIMAL FTE (1 = full-time, 0.5 = half, 0.25 = quarter). Map "hrs/wk" or "% time" to a decimal FTE; if not shown, use null (NOT 0.5).
- staffTitle MUST carry the person's REAL professional title / SENIORITY exactly as written next to their name — e.g. "Principal in Charge", "Partner", "Executive Director", "Senior Director", "Project Manager", "Project Support", "Project Coordinator", "Analyst". DO NOT flatten everyone to "Project Manager". A leader / "in charge" / "principal" / "partner" is senior; a "support" / "coordinator" / "assistant" / "analyst" is junior. Preserve those seniority words — the app maps them to a rate level, so getting the title right is critical.
- If a person's hourly rate isn't shown but a monthly rate or total is, leave rate null. A matrix with MULTIPLE discount columns → use the NON-DISCOUNTED / standard hourly rate.
- Roster and rates may live on different pages — correlate by person or title. staffTitle = professional title as written (e.g. "Principal in Charge", "Project Manager"). projectRole = their role on THIS project if stated separately. team = workstream/group if grouped.
- narrative MUST be honest about what's missing: explicitly say when the period, durations, fee, or rates are NOT stated in the document, rather than implying values. Mention the project budget if given, clearly labeled as budget (not fee).
- Money: strip $ and commas → plain numbers. Dates: "MON YYYY". Use null when truly unknown. Capture EVERY person.`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on the server' }); return; }
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

  try {
    const { text, images } = req.body || {};
    const content = [];
    // Vision: attach page images first (best for designed/scanned proposals).
    if (Array.isArray(images)) {
      for (const img of images.slice(0, 16)) {
        const m = /^data:(image\/\w+);base64,(.+)$/.exec(img || '');
        if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      }
    }
    content.push({ type: 'text', text: buildPrompt() + (text ? ('\n\nPROPOSAL TEXT:\n' + String(text).slice(0, 24000)) : '') });

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: SYSTEM,
        messages: [{ role: 'user', content }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) { res.status(resp.status).json({ error: data.error?.message || 'Claude API error', detail: data }); return; }

    let txt = (data.content || []).map(b => b.text || '').join('').trim();
    txt = txt.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
    if (a >= 0 && b >= 0) txt = txt.slice(a, b + 1);
    const parsed = JSON.parse(txt);
    res.status(200).json(parsed);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
