# Scenarios the system is checked against

Each line is something that can happen at a customer or at build time, what must happen, and where it is tested.
`Auto` = a test in `qa/` or a self-test fails if it breaks. `Windows` = check by hand on the installed app (see `docs/RELEASE_GUIDE.md`).

## A. Build and release
| Scenario | Must happen | Checked |
|---|---|---|
| No licence public key / no recovery public key | Build stops, says which command to run | Auto: release-check |
| A private key, old secret or self-test file would be inside the installer | Build stops | Auto: release-check |
| Dev bypass file not excluded, or main.js reads `POS_LICENSE_DEV` | Build stops | Auto: release-check |
| A new page is added but not put in the tier list | Build stops (it would be open to everyone) | Auto: release-check, G16 |
| Git tracks a secret, `.gitignore` lacks `license-keys/` | Build stops | Auto: release-check |
| Installer is per-user / fuses hook missing | Warning only | Auto: release-check |
| Exe renamed to `electron.exe` + `POS_LICENSE_DEV=1` | No bypass | Auto: E05 + Windows #6 |
| `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect` | Switched off by fuses | Windows #7 |
| `app.asar` edited | Only stopped if ASAR integrity is on (opt-in) | Windows #13 |
| Someone runs `license:keys` / `recovery:keys` a second time | Refused, private key never overwritten | Auto: release-check |

## B. Keys and activation
| Scenario | Must happen | Checked |
|---|---|---|
| Valid key | Unlocks at once | A01 |
| Any edit to a key (date, PC, plan, tier, name, epoch) | Rejected (signature) | A02, G01, G02 |
| Key signed by someone else, unknown key id, truncated, empty, wrong prefix | Rejected, never a crash | A05-A07, A15 (4000 random edits) |
| Key for another PC | Rejected with a plain message | A09 |
| Key pasted from WhatsApp (line breaks, spaces, invisible direction marks) | Works | A13, A14 |
| Repair code used as a licence, or a licence as a repair code | Rejected | A08 |
| Key issued for an older app version (epoch) | Rejected, clear message | A11 |
| Already-expired key | Refused, not saved | B09 |
| Two keys entered at the same moment | Both saved, no corruption | H19, C18 |
| Vendor PC date was wrong when the key was made | Tool refuses; if it got out, repair code + corrected key fixes it | F01, F02, H20 |
| Issue tool run without `--tier`, or with input closed | Fails loudly, nothing issued | F06, F07 |

## C. Tiers
| Scenario | Must happen | Checked |
|---|---|---|
| No key / invalid / expired | Free: only Settings (+ Backup, PIN lock, printers, License) | G03, G04, G12 |
| Pro | Every page except WhatsApp Deals; WhatsApp calls refused in the main process | G05-G07 |
| Premium | Everything | G08 |
| Old key (before tiers) | Runs as Premium exactly as before | G09, H17 |
| Key with a bad tier value | Rejected | G10 |
| A channel nobody classified | Treated as Pro, never free | G18, G19 |
| Screen shows lock tags and a short message | Dashboard, dock, search, router | UI test |

## D. Several licenses (Pro + Premium on one PC)
| Scenario | Must happen | Checked |
|---|---|---|
| Premium entered while Pro runs | Premium starts now, Pro paused with days kept | H01, H02 |
| Customer presses "Use this" | Switch; the other is paused and frozen | H03, H11, UI test |
| Premium ends | Pro starts by itself, never Free in between | H04 |
| Lower-tier key entered while a higher one runs | Saved paused; running one unchanged | H05, G13 |
| Paused license renewed | Stays paused, more days | H06 |
| Both ended | Free | H07 |
| Restart, power off for days | Same license, same paused days | H08 |
| Pause data deleted / edited | No crash; no free days; edits are capped | H09, H10 |
| 100 quick switches | Total days only go down by real time | H13 |
| PC clock +5 years / back while a license is paused | No gain | H14 |
| Downgrade / refund (`--exclusive`) | Other license removed; old key cannot return, also after restart | G14, H12 |
| Renewal after an exclusive key | New newer key works | H12c |
| Key for the other PC, garbage in the stored list | Ignored safely | H15, H16 |

## E. Time and PC changes
| Scenario | Must happen | Checked |
|---|---|---|
| PC date put back / jumped forward | No gain, no lock | C02-C04 |
| POS off for a month, laptop sleep | At most 7 days counted per gap | C05, C06 |
| Calendar copies deleted / corrupt / one unreadable | Starts; orders and backups keep the calendar from going back | C08-C13 |
| Repair code replayed | Single use; replay with no orders is a documented limit | C15 |
| Windows reinstalled / new PC | New Hardware ID; you issue a new key (manual guide #6) | D01, manual |
| `reg.exe` fails once at start | Retries; session never locked | D03, D04 |

## F. Forgot PIN
| Scenario | Must happen | Checked |
|---|---|---|
| Developer reply | Unlocks that PC, that day | R02-R04 |
| Wrong PC, edited reply, someone else's key, licence key, junk | Refused, no crash | R03, R05-R11 |
| No recovery key in the build | Nothing is accepted | R07 |
| Secret inside the app | None (no HMAC, no shared secret) | R12 |

## G. WhatsApp
| Scenario | Must happen | Checked |
|---|---|---|
| Licence ends / drops to Pro during a campaign | Stops at the next step; resumes after renewal, no repeats | whatsapp-license-qa |
| App closed normally mid-campaign | Next start: paused bar, Resume continues exactly | whatsapp-license-qa, UI test |
| Power cut / crash mid-message | That one customer is "not sure"; never re-sent by itself; owner chooses Send again or Skip | whatsapp-license-qa |
| Sending speed slider | Seven stops; faster than Optimized needs the tick; limits 3-120 s / 1-60 min | whatsapp-timing-qa, UI test |
| Faster speed edited into the database | Ignored, safe speed used | whatsapp-timing-qa |
| Settings can't be read | Safe speed | whatsapp-timing-qa |

## H. Typing
| Scenario | Must happen | Checked |
|---|---|---|
| Delete / Clear buttons used, then Search | Typing still works (no native dialog) | UI test, Windows #12 |
| A native dialog sneaks back in | Blocked by the main window; the test fails | UI test |
