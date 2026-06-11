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
     CLAUDE_MODEL      = claude-sonnet-4-20250514   (optional; override if needed)

   REQUEST  (POST JSON)
     { text?: string, images?: ["data:image/png;base64,...", ...] }
   RESPONSE (JSON)
     { narrative, project, phases, people }   // see SCHEMA in the prompt
   ============================================================ */

const SYSTEM = `You are an expert at reading professional-services FEE PROPOSALS and FEE MATRICES (project & program management, change management, relocation, workplace) and turning them into structured data. You are precise with money, dates, durations, and people. You never invent numbers; if something isn't stated, you use null.`;

function buildPrompt() {
  return `Read the attached proposal / fee matrix and extract it. Return ONLY minified JSON (no prose, no code fence) with EXACTLY this shape:

{
 "narrative": string,            // 2-4 plain sentences telling the story: the client & project, the period (start–end), how many people, the team structure, the total fee, and how it's billed. Write it like a deal summary a principal would skim.
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
- phases = the project schedule / timeline. Capture each phase's name, its DURATION in weeks (if stated in months, convert ×4.345), its date span, and its stated fee if the proposal breaks fee out by phase. Order chronologically.
- people = the staffing roster / fee matrix rows. allocation is a DECIMAL FTE (1 = full-time, 0.5 = half, 0.25 = quarter). Map "hrs/wk" or "% time" to a decimal FTE. rate = hourly USD.
- If a person's hourly rate isn't shown but a monthly rate or total is, leave rate null (the app will derive it) — do NOT guess.
- A matrix often has MULTIPLE discount columns (non-discounted, 6%, 9%…). Use the NON-DISCOUNTED / standard hourly rate for "rate".
- Roster and rates may live on different pages/sheets — correlate by person or by title.
- If there is NO hourly roster but the proposal names a team, leads, or signatories with titles, include them as people with allocation 0.5 and rate null so staffing can be solved later.
- staffTitle = the person's professional/HR title as written (e.g. "Senior Project Manager", "Change Management Lead"). projectRole = their role on THIS project if stated separately.
- team = which workstream/group they sit in (e.g. "Change Management", "PM", "Relocation") if the proposal groups them.
- Money: strip $ and commas, return plain numbers. Dates: "MON YYYY" like "Jun 2026". Use null when truly unknown. Be thorough — capture EVERY person in the matrix.`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on the server' }); return; }
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

  try {
    const { text, images } = req.body || {};
    const content = [];
    // Vision: attach page images first (best for designed/scanned proposals).
    if (Array.isArray(images)) {
      for (const img of images.slice(0, 12)) {
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
