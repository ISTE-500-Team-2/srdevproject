# Fieldnote v0.5 stack preview (visual only)

`reader-with-interface.kicad_pcb` is a **copy** of the v0.5 reader board with one visual-only footprint (`STACK1`,
excluded from BOM/position files) whose 3D model is the interface board STEP:
`../fieldnote-interface-board-v0.1/output/3d/fieldnote-interface-v0.1.step`. Do not use this file for fabrication.

- Model offset z = -7.6 mm, which gives about 4.4 mm board-to-board gap. The reader J6 header meets the J2 socket at this offset;
  the real mated height depends on the exact Samtec FTSH/CLP pair and must be taken from their drawings.
- The interface board is **placement only** (50 parts, 0 placement errors, not routed): `../fieldnote-interface-board-v0.1/place_interface.py`.
- Buzzer is now the PUI SMT-1240-S-HT SMD piezo (2.8 mm). Wall-side height is set by J1 (about 4.3 mm) and L1 (4.5 mm).
  Measured from the side render (about 20.4 px/mm): overall stack about 15 mm from the USB-C top to the J1 bottom, down from
  about 20.4 mm with the old 9.5 mm buzzer. These are render estimates, not CAD measurements.

Renders: `stack-iso-back.png`, `stack-iso-front.png`, `stack-side.png`, `stack-back.png`.
