# Independent PN7160 verification

These tests exercise the production `fieldnote_nci::Reader` through its abstract transport and extract the actual product codec/rollback functions into a temporary host fixture. They do not substitute a second implementation of the driver. No hardware is flashed or accessed.

From this directory:

```sh
python3 run_verification.py
```

The runner compiles with strict warnings and AddressSanitizer/UndefinedBehaviorSanitizer, saves the individual logs and [verification-results.json](verification-results.json), and records the exact source hashes. To run the protocol and codec suites separately:

```sh
c++ -std=c++11 -Wall -Wextra -Werror test_pn7160_protocol.cpp -o /tmp/fieldnote-pn7160-protocol-test
/tmp/fieldnote-pn7160-protocol-test
python3 run_product_contract_tests.py
```

The protocol suite covers 52 cases: atomic NCI2 RESET/INIT and configuration application, ON-mode crystal clock selection/no startup boost and full clock/PMU read-back, preserved OFF/reserved PMU fields, 87-byte DPC configuration/read-back, first scan and repeated no-tag polling without idle deactivation, FRAME/Classic mappings, 4/7-byte UID handling and product memory policy, rejection of 10-byte and malformed activations, multiple discovery notifications, sector/key authentication, exact block/page frames, both Classic write ACK stages, NAKs, safe memory boundaries, standalone/piggyback credits, malformed headers, missing replies, clock wrap, power loss, removal/replacement before and between write stages, replacement preventing later rollback (including same-UID reactivation), reset and transport failures. Fragmented messages are rejected and force recovery; reassembly is not implemented.

The product suite verifies 11 unchanged codec/CRC/rollback functions against the frozen v0.2 source, reviews API/confirmation/UID/length/persistence guards, and runs 13 actual-function fixture cases. Independent vectors check CRC-16/CCITT-FALSE, little-endian record CRC, 36 UTF-8 byte limits, NDEF text/URI layout and parsing, malformed TLVs, bounded write regions, Type2 commit order, rollback after an ambiguous failed write and cancellation when power loss prevents rollback. HTTP checks here are source checks; the owner's UI suite separately exercises browser behavior.

Eight actual qualifier cases cover initial default service, continuous 100 ms qualification, cancellation/recovery, advertisement bounce and clock wrap. Source review verifies active-HIGH VEN is LOW at cold startup and downgrade, the initial NCI boot precedes Wi-Fi, polling waits for enrollment, and CDC is required to isolate GPIO20 from UART RX. The native pad-net/metadata snapshot checks 36 relevant pin assignments, the 100 kΩ VEN pull-down and R27 fitted/R28 DNP service links. It does not establish routed connectivity. The 10 ms task period is not a measured shutdown latency.

Primary protocol sources are [NXP UM11495 rev1.8](https://www.nxp.com/docs/en/user-manual/UM11495.pdf), §§3.3,4.2,5.3.1,6.1,7.1; [AN12989](https://www.nxp.com/docs/en/application-note/AN12989.pdf), §4.3; [Classic EV1 data sheet](https://www.nxp.com/docs/en/data-sheet/MF1S50YYX_V1.pdf), §12.3; [NTAG213/215/216 data sheet](https://www.nxp.com/docs/en/data-sheet/NTAG213_215_216.pdf), §§9.3,10.2,10.4; and NXP's `NCI2.0_PN7160` [MIFARE host code](https://github.com/NXPNFCLinux/linux_libnfc-nci/blob/NCI2.0_PN7160/src/nfcandroid_nfc_hidlimpl/halimpl/mifare/NxpMfcReader.cc) / [Type2 status definitions](https://github.com/NXPNFCLinux/linux_libnfc-nci/blob/NCI2.0_PN7160/src/nxp_nci_hal_libnfc-nci/src/nfc/include/tags_defs.h). Only protocol facts are used; no NXP implementation code is copied into these tests.

The mocks establish host behavior for the selected packet sequences. They do not establish PN7160 firmware-version compatibility, real IRQ timing, radio-stop latency, RF ACK/NAK behavior, NFC range/yield, tag-write reliability, USB current/ripple/thermal or physical rollback. Perform [factory-test-PN7160.md](../../manufacturing/factory-test-PN7160.md) on both first articles before release. A compile or mock PASS must not fill a physical result cell.
