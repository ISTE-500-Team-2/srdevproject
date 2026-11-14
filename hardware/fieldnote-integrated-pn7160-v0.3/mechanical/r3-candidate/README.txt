FIELDNOTE PN7160 / R3 RETENTION EXPLORATION

NO CANDIDATE ADOPTED; FROZEN R2 AND ALL CAD/PACKAGES UNCHANGED

The coordinating agent requested a cheap contact4 move to improve the assumed
U1/contact4 4.0 mm bulge gap toward 0.25 mm. These comparisons preserve the
2.4 mm contact, 4.0 mm bulge, all post/pad dimensions, pad compression range,
individual component +/-0.10 mm / +/-1 degree, and whole-PCB +/-0.20 mm XY.
Neither those budgets nor component envelopes were reduced to create a pass.

Inputs are the adopted saved-fill native-v3 board (16c767ce...), metadata
(e5db89f4...), final all-78 purchased component prisms and actual 99-footprint
native pad/drill/via geometry. R2's full 243 sampled + 27 continuous rigid +
27 continuous pad checks remain frozen. The new comparisons are an explicit
local/nonlocal layout exploration, not a new full-screen geometry PASS.

LOCAL CONSTRAINTS

Contact4 starts at board-local [64.0,41.5] mm. Its 2.4 mm square swept through
the +/-0.20 mm global PCB pose has half-width 1.4 mm. The PCB right edge x65.5
therefore limits its center to x64.1; rear y45.2 limits its center to y43.8.
At the rear site, every small y move overlaps U1's continuous assumed body:
  board-local X [47.6380840059,61.9619159941]
  board-local Y [26.9380840059,44.6619159941]
With the 4 mm bulge, even removing the wall entirely would permit at most
0.138084 mm U1 clearance at x64.1. A 0.25 mm X clearance would require center
x64.211916, whose full swept contact extends 0.111916 mm outside the PCB.
Passing below U1 in Y would require case-center y50.711916, while full contact
containment permits at most y47.6. Passing above it requires a large move away
from this rear support site and into the populated component region.

The actual wall constrains the site still more. R2's prescribed 4 mm bulge is
effectively tangent to its inner face: minimum mesh gap 0.000003052 mm at the
worst vertical envelope. Outward shifts of 0.03 / 0.04 / 0.08 / 0.10 mm cause
actual pad/source-case intersection volumes of approximately 0.211 / 0.282 /
0.563 / 0.704 mm^3. No local wall pocket was made: it could not resolve the
PCB-contact limit and would require a new wall-strength review.

contact4-comparisons.json records 3234 local positions over x63.0..64.2 and
y39.0..44.2 mm, including selected intermediate moves. Only 61 pass the
preliminary contact/body/exposed-pad/drill/via/wall checks. Accepted x values
are 63.98..64.00; their best U1/bulge gap remains the original 0.038084 mm.
Moving inward opens a wall gap while reducing U1 clearance. This is a geometric
constraint, not a recommendation to accept the small physical margin.

NONLOCAL GEOMETRY ALTERNATIVE ONLY

nonlocal-contact4-comparisons.json records 1520 positions on the solid PCB left
of the ESP32 antenna notch, including the original site for comparison.
At [45.3,41.5], the full contact sweep stays on PCB and avoids all actual exposed
pads, pad drills and via drills. Its assumed component/bulge gap is 0.338084 mm
and its source-case gap is 2.390 mm. At [45.0,41.5], those gaps are 0.638084 and
2.390 mm. These are 18.7–19 mm moves, not small local shifts.

They preserve four contacts and the individual post/pad/compression dimensions
but change the planar support-center hull and load distribution. The U1 native
origin is outside the revised support hull, whereas it is inside the R2 hull.
No retention-force equivalence, PCB bending strength or pad behavior is implied.
The coordinating agent instructed that this remain a separately labeled
geometry alternative only. Neither position is adopted or exported for printing.

DISPOSITION

Local 0.25 mm target is infeasible under the unchanged rear-site geometry and
budgets. No R3 printable case, parameter revision, full 243/27/27 screen or
manufacturing release is issued. R2's earlier bounded PASS is preserved with
its physical REVIEW/HOLD conditions, now supplemented by this exact wall/site
constraint evidence. A different load arrangement or revised board/retention
geometry would need a new design and physical qualification before adoption.

explore_contacts.py and explore_rear_alternatives.py reproduce the comparisons;
freeze_inputs.py checks the explicit native-v3 owner adoption. All inputs,
comparison/source hashes and unchanged R2/v0.2 evidence are recorded in
review-handoff.json. r2-preservation.json records the original R2 file bindings.
