# Demo

<!--
Describe the video you want. Plain English — the skill turns this into a
storyboard, records it, narrates it and exports it.

Keep the flow to what a judge needs to see in 60–90 seconds. Delete this
comment and the example, and write yours.
-->

**App:** http://localhost:3000
**Length:** about 75 seconds
**Look:** dark

## Flow

1. Land on the dashboard. Say that this is a tool for tracking carbon spend
   across a supply chain, and that everything on screen is live data.
2. Click into the "Suppliers" tab and hover the worst-performing row. Say that
   the scoring is computed on ingest, not nightly, so it is current.
3. Open a supplier. Scroll to the emissions chart. Say that this is the part we
   built at the hackathon — the per-shipment breakdown nobody else exposes.
4. Click "Generate report". Say that it produces an auditor-ready PDF in one
   step, which is the whole pitch.
5. End on the report. Say what we would build next.

## Notes

- The search box is `input[data-testid=search]` if you need it.
- Skip the login screen; the dev server is already authenticated.
