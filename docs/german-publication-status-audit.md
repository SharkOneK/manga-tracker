# Audit: Deutschsprachiger Veröffentlichungsstatus

> Phase 38 (2026-05-24): Der Wert `ongoing` (`true` | `false` | `unknown`) bezieht sich
> ab sofort eindeutig auf die **deutschsprachige Veröffentlichung** einer Serie/Edition.
> Der japanische / originale Veröffentlichungsstatus ist nicht mehr Grundlage für `ongoing`.

## Vorgehensweise

1. Jede im Repository als Seed gepflegte Serie wird gegen die folgende Frage geprüft:
   > „Erscheinen im deutschsprachigen Raum noch reguläre Bände dieser Ausgabe?“
2. Quelle ist primär das Feld `notes` der Seed-Definition in `src/app.js`,
   das pro Serie bereits DE-Erscheinungsinformationen enthält
   (Verlagsprogramm, ISBN, DE-Releases, Editionsformat).
3. Ein Wert wird nur dann geändert, wenn er mit der neuen Semantik nicht vereinbar
   ist und eine belastbare Quelle vorliegt.
4. Unklare Fälle bleiben oder werden auf `unknown` gesetzt – sie werden nicht geraten.
5. Bestehende Besitz-, Lese- oder Banddaten (`bands`, `owned`, `status`, `startedAt`,
   `finishedAt`) werden im Rahmen dieser Phase nicht angefasst.

## Geltungsbereich

- Auditiert werden die im Repository fest verdrahteten Seeds in `src/app.js`.
- Private Sammlungseinträge eines Nutzers werden hier nicht aufgelistet
  (sie liegen ausschließlich lokal bzw. in der privaten Supabase-Projektion).
- Editionen werden separat betrachtet: Eine Master-/Doppelband-/Perfect-Edition
  ist nicht automatisch identisch mit dem Originalstatus der zugrundeliegenden Serie.

---

## Audit-Ergebnis pro Seed

Legende:

- ✅ – Seed-Wert ist konsistent mit der Phase-38-Semantik (DE-Stand korrekt abgebildet).
- ⚠️ – Wert kann mit der DE-Semantik korrekt sein, sollte aber bei nächster Gelegenheit
  manuell gegen die Verlagsseite gegengeprüft werden.
- 🔁 – Wert wirkt unter der DE-Semantik fragwürdig; Empfehlung: bei nächster Pflege
  ggf. auf `unknown` setzen, bis eine offizielle Verlagsquelle eine eindeutige
  Aussage erlaubt. (Im Rahmen dieser Phase **nicht** automatisch geändert.)

---

### Parasite in Love (Egmont Manga)
- Aktuell: `ongoing: "false"` · 3/3 Bände
- Notes: „Abgeschlossene Serie – 3 Bände (DE).“
- Bewertung: ✅ DE-Ausgabe vollständig erschienen.

### Wie die Götter es wollen (Tokyopop)
- Aktuell: `ongoing: "false"` · 1/1 (Einzelband)
- Notes: „Einzelband, 356 Seiten. Erschienen: Februar 2023.“
- Bewertung: ✅ Einzelband, DE-Ausgabe abgeschlossen.

### Vagabond – Master Edition (Egmont Manga)
- Aktuell: `ongoing: "false"` · 7/19 ME-Bände
- Notes: „Doppelband-Edition (2-in-1). Band 8 seit 07.04.2026 verfügbar.
  Inoue auf Hiatus seit 2015, 37 Originalbände = ca. 19 ME-Bände.“
- Bewertung: 🔁 Solange Egmont die Master Edition planmäßig fortsetzt (Band 8 in 2026),
  ist die DE-Ausgabe nicht *abgeschlossen*, sondern entweder **laufend** oder, falls
  weitere ME-Bände nicht offiziell zugesagt sind, **unknown**. Empfehlung: bei
  nächster Pflege Verlagsprogramm/Egmont-Shop prüfen.
  → Bis dahin in dieser Phase **nicht** automatisch verändert.

### Uzumaki Deluxe (Carlsen Manga)
- Aktuell: `ongoing: "false"` · 1/1
- Notes: „3-in-1 Deluxe Hardcover, Einzelband.“
- Bewertung: ✅ DE-Ausgabe komplett.

### Tomb Town Deluxe (Carlsen Manga)
- Aktuell: `ongoing: "false"` · 1/1
- Notes: „Deluxe Einzelband.“
- Bewertung: ✅ DE-Einzelband, abgeschlossen.

### Tokyo Revengers – Doppelband-Edition (Carlsen Manga)
- Aktuell: `ongoing: "false"` · 8/16
- Notes: „Doppelband-Edition. Band 9+ bereits erhältlich. Originalserie abgeschlossen
  (31 Bände = 16 Doppelbände).“
- Bewertung: ⚠️ Wenn alle 16 DE-Doppelbände erschienen sind, ist „abgeschlossen“ korrekt.
  Beim nächsten Pflegezyklus prüfen, ob Band 16 (DE) tatsächlich bereits ausgeliefert wurde.

### Mujina into the Deep (Tokyopop)
- Aktuell: `ongoing: "true"` · 3/4
- Notes: „Band 4 (DE) seit April 2026 verfügbar. Quartalsrhythmus.“
- Bewertung: ⚠️ Wenn DE bei Band 4 endet (Original JP unklar), ggf. auf `false`/`unknown`
  setzen. Quartalsrhythmus deutet auf weitere DE-Bände, bis Verlag das Gegenteil sagt.

### MoMo – the blood taker (Crunchyroll Manga)
- Aktuell: `ongoing: "false"` · 9/9
- Notes: „Abgeschlossen – 9 Bände.“
- Bewertung: ✅ DE-Ausgabe komplett.

### Mirai Nikki – New Edition (Egmont Manga)
- Aktuell: `ongoing: "true"` · 2/6
- Notes: „2-in-1 Doppelbände. 6 Bände geplant (12 Orig.).“
- Bewertung: ✅ DE-Ausgabe läuft planmäßig.

### Mars Red (Crunchyroll Manga)
- Aktuell: `ongoing: "false"` · 3/3
- Notes: „Abgeschlossen – 3 Bände (DE = JP).“
- Bewertung: ✅

### Maria's Judgement (Egmont Manga)
- Aktuell: `ongoing: "true"` · 5/6
- Notes: „6 Bände geplant. Band 6 ursprünglich 11.05.2026, verschoben – neues Datum offen.“
- Bewertung: ✅ Solange Band 6 angekündigt bleibt, ist `laufend` korrekt.

### Look Back (Egmont Manga)
- Aktuell: `ongoing: "false"` · 1/1
- Notes: „Einzelband.“
- Bewertung: ✅

### Lili-Men (Egmont Manga)
- Aktuell: `ongoing: "true"` · 5/8
- Notes: „13 Bände geplant (JP). Band 5: Dez. 2025. Band 6 wahrsch. März 2026.“
- Bewertung: ✅ DE läuft planmäßig.

### Kijin Gentosho: Dämonenjäger (Panini Manga)
- Aktuell: `ongoing: "true"` · 1/8
- Notes: „Band 8 seit Jan. 2026 verfügbar. Band 2–8 alle erhältlich.“
- Bewertung: 🔁 Wenn DE bei Band 8 endet, wäre eher `false`; läuft die Reihe weiter,
  ist `true` korrekt. Verlagsprogramm Panini prüfen.

### Kaiju No.8 Side (Crunchyroll Manga)
- Aktuell: `ongoing: "false"` · 2/2
- Notes: „Abgeschlossen – 2 Bände.“
- Bewertung: ✅

### Kaiju No.8 (Crunchyroll Manga)
- Aktuell: `ongoing: "false"` · 15/16
- Notes: „Abgeschlossen – 16 Bände. Band 16 (Finale) seit März 2026 verfügbar.“
- Bewertung: ✅ DE-Ausgabe vollständig erschienen.

### Kagurabachi (Carlsen Manga)
- Aktuell: `ongoing: "true"` · 6/7
- Notes: „Band 7: 26.05.2026. Band 8: 28.07.2026.“
- Bewertung: ✅

### Jujutsu Kaisen (Kazé Manga)
- Aktuell: `ongoing: "false"` · 2/30
- Notes: „Abgeschlossen – 30 Bände (inkl. Band 0). Band 2–30 alle bereits verfügbar.“
- Bewertung: ✅ DE-Ausgabe vollständig.

### Happiness (Manga Cult)
- Aktuell: `ongoing: "false"` · 5/5
- Notes: „Abgeschlossen – 5 Doppelbände.“
- Bewertung: ✅

### Gute Nacht, Punpun (Tokyopop)
- Aktuell: `ongoing: "false"` · 13/13
- Notes: „Abgeschlossen – 13 Bände.“
- Bewertung: ✅

### Real Account (Tokyopop)
- Aktuell: `ongoing: "false"` · 5/6
- Notes: „DE-Ausgabe scheinbar bei Band 6 eingestellt (Band 6 vergriffen). Original JP: 24 Bände.“
- Bewertung: 🔁 „scheinbar eingestellt“ ist keine belastbare Verlagsquelle.
  Nach Phase-38-Regel („Deutsch pausiert, abgebrochen oder ohne belastbare
  Information → `unknown`“) wäre `unknown` der korrektere Wert. Empfehlung:
  bei nächster Pflege auf `unknown` setzen, sobald ein Blick auf
  tokyopop.de das Ende oder die Fortsetzung der Reihe bestätigt.
  → Im Rahmen dieser Phase **nicht** automatisch verändert.

### Neon Genesis Evangelion – Perfect Edition (Carlsen Manga)
- Aktuell: `ongoing: "false"` · 7/7
- Notes: „Abgeschlossene Perfect Edition – 7 Sammelbände.“
- Bewertung: ✅

### Neck mich nicht, Nagatoro-san (dani books)
- Aktuell: `ongoing: "true"` · 4/6
- Notes: „Band 5 seit 31.03.2026 verfügbar. Band 6 Sommer 2026.“
- Bewertung: ✅

### Reincarnated as a Sword: Another Wish (Dokico)
- Aktuell: `ongoing: "true"` · 1/4
- Notes: „6 Bände geplant (3-Monats-Rhythmus). Band 2: 21.04.2026. Band 3: ca. Aug. 2026.“
- Bewertung: ✅

### Sakura – I want to eat your pancreas (Carlsen Manga)
- Aktuell: `ongoing: "false"` · 2/2
- Notes: „Abgeschlossene Serie – 2 Bände. Neue Pearls Edition (Doppelband) erscheint 28.07.2026.“
- Bewertung: ✅ für die bestehende Ausgabe.
  Die Pearls Edition ist eine **eigene** Edition und sollte – falls aufgenommen –
  als separater Eintrag mit eigenem DE-Status geführt werden.

### Solo Leveling (Altraverse)
- Aktuell: `ongoing: "false"` · 15/15
- Notes: „Hauptstory abgeschlossen (15 Bände). Sequel: Solo Leveling: Ragnarok.“
- Bewertung: ✅ Hauptreihe DE-komplett. Ein eventuelles Sequel ist eine andere Serie.

### Spy x Family (Crunchyroll Manga)
- Aktuell: `ongoing: "true"` · 3/15
- Notes: „Band 15 (DE) seit 03.04.2026 verfügbar. Japan: 17 Bände.“
- Bewertung: ✅ Beide Ausgaben laufen weiter; DE laufend ist korrekt.

### Takopi und die Sache mit dem Glück (Hayabusa)
- Aktuell: `ongoing: "false"` · 2/2
- Notes: „Abgeschlossene Serie – 2 Bände.“
- Bewertung: ✅

### The Eminence in Shadow (Tokyopop)
- Aktuell: `ongoing: "true"` · 8/9
- Notes: „Band 9 im Tokyopop-Programm Mär–Aug 2026. Quartalsweise Erscheinung.“
- Bewertung: ✅

### Tengu – Das Böse im Blut (Kazé Manga)
- Aktuell: `ongoing: "false"` · 7/7
- Notes: „Abgeschlossene Serie – Band 7 ist der Abschlussband.“
- Bewertung: ✅

### The Vote (Hayabusa)
- Aktuell: `ongoing: "false"` · 7/7
- Notes: „Abgeschlossene Serie, 7 Bände (DE = JP).“
- Bewertung: ✅

### Witch and Hound (Egmont Manga)
- Aktuell: `ongoing: "true"` · 2/4
- Notes: „Band 3: 11.05.2026. Band 4: 04.08.2026.“
- Bewertung: ✅

### Yakuza Reincarnation (Manga Cult)
- Aktuell: `ongoing: "true"` · 14/16
- Notes: „Band 16 (DE) erscheint 11.06.2026 (Quelle: cross-cult.de). Japan: 19+ Bände.“
- Bewertung: ✅ DE läuft, weitere Bände werden erwartet.

### Yandere Dark Elf (MangaMoon)
- Aktuell: `ongoing: "true"` · 2/3
- Notes: „Band 3 erscheint 29. Mai 2026.“
- Bewertung: ⚠️ Wenn DE bei Band 3 endet, wäre nach Erscheinen `false` korrekt.
  Solange unklar ist, ob es Band 4 (DE) gibt, bleibt `true` vertretbar – nach
  Erscheinen prüfen.

### Gushing over Magical Girls (MangaMoon)
- Aktuell: `ongoing: "true"` · 2/4
- Notes: „Laufende Serie bei MangaMoon.“
- Bewertung: ✅

### Goodbye, Eri (Egmont Manga)
- Aktuell: `ongoing: "false"` · 1/1
- Notes: „Einzelband.“
- Bewertung: ✅

### Gannibal (Hayabusa)
- Aktuell: `ongoing: "false"` · 13/13
- Notes: „Abgeschlossene Serie, 13 Bände.“
- Bewertung: ✅

### From the Red Fog (Manga Cult)
- Aktuell: `ongoing: "false"` · 1/5
- Notes: „Abgeschlossene Serie, 5 Bände.“
- Bewertung: ✅

### Frankenstein von Junji Ito (Carlsen Manga)
- Aktuell: `ongoing: "false"` · 1/1
- Notes: „Einzelband.“
- Bewertung: ✅

### Fairy Tail (Carlsen Manga)
- Aktuell: `ongoing: "false"` · 15/63
- Notes: „Abgeschlossene Serie, 63 Bände (DE).“
- Bewertung: ✅

### Elfen Lied (Tokyopop)
- Aktuell: `ongoing: "false"` · 6/6
- Notes: „Abgeschlossen, 6 Doppelbände (DE).“
- Bewertung: ✅

### Die letzte Elfe (Yomeru)
- Aktuell: `ongoing: "true"` · 1/3
- Notes: „Band 2 (DE) erschienen 27.03.2026. Band 3: 25.12.2026.“
- Bewertung: ⚠️ Nach Erscheinen von Band 3 prüfen, ob die DE-Reihe damit komplett ist.

### Die Blutprinzessin (Egmont Manga)
- Aktuell: `ongoing: "false"` · 5/5
- Notes: „Abgeschlossene Serie, 5 Bände (DE).“
- Bewertung: ✅

### Demon King of God Killing (Egmont Manga)
- Aktuell: `ongoing: "true"` · 3/4
- Notes: „Band 4 erschienen 11.05.2026. Serie laufend (JP: 5+ Bände).“
- Bewertung: ✅

### Dandadan (Kazé Manga)
- Aktuell: `ongoing: "true"` · 20/21
- Notes: „Band 21: 03.07.2026.“
- Bewertung: ✅

### Dai Dark (Manga Cult)
- Aktuell: `ongoing: "true"` · 7/9
- Notes: „Band 9: 11.06.2026.“
- Bewertung: ✅

### Colorless (Manga Cult)
- Aktuell: `ongoing: "false"` · 2/7
- Notes: „Abgeschlossen, 7 Bände (DE bei Manga Cult, Abschlussband August 2024).“
- Bewertung: ✅

### CHILDEATH (Altraverse)
- Aktuell: `ongoing: "false"` · 3/3
- Notes: „Abgeschlossen, 3 Bände.“
- Bewertung: ✅

### Chainsaw Man (Egmont Manga)
- Aktuell: `ongoing: "true"` · 20/23
- Notes: „Band 22: 04.08.2026.“
- Bewertung: ✅

### Call of the Night (Tokyopop)
- Aktuell: `ongoing: "false"` · 20/20
- Notes: „Abgeschlossen mit Band 20 (Abschlussband, Okt 2025).“
- Bewertung: ✅

### Brynhildr in the Darkness (Tokyopop)
- Aktuell: `ongoing: "false"` · 11/18
- Notes: „Abgeschlossene Serie, 18 Bände (DE).“
- Bewertung: ✅

### Blood on the Tracks (Manga Cult)
- Aktuell: `ongoing: "false"` · 17/17
- Notes: „Abgeschlossene Serie, 17 Bände (DE).“
- Bewertung: ✅

### Blood Lad EXTREME (Tokyopop)
- Aktuell: `ongoing: "false"` · 8/8
- Notes: „Abgeschlossen, 8 Sammelbände.“
- Bewertung: ✅

### Blood Blade (Hayabusa)
- Aktuell: `ongoing: "true"` · 3/5
- Notes: „Band 5 (DE) erscheint 30.06.2026. Band 4 bereits erhältlich.“
- Bewertung: ⚠️ Nach Erscheinen von Band 5 prüfen, ob DE damit komplett ist.

### Berserk Master Edition (Panini Manga)
- Aktuell: `ongoing: "true"` · 4/14
- Notes: „Band 5: 17.03.2026. Band 6: 16.06.2026. Ca. 14 ME-Bände gesamt.“
- Bewertung: ✅ Die ME wird planmäßig fortgesetzt.

### August 9th, I will be eaten by you (Hayabusa)
- Aktuell: `ongoing: "true"` · 4/6
- Notes: „Band 6 (DE) angekündigt für Dezember 2026.“
- Bewertung: ✅

### Attack on Titan (Carlsen Manga)
- Aktuell: `ongoing: "false"` · 34/34
- Notes: „Abgeschlossene Serie, 34 Bände (DE = JP).“
- Bewertung: ✅

### Arifureta Zero (Altraverse)
- Aktuell: `ongoing: "true"` · 2/8
- Notes: „Prequel-Manga, 8 Bände gesamt (JP abgeschlossen). Quartalsweise DE-Release.“
- Bewertung: ✅

### Adou (Altraverse)
- Aktuell: `ongoing: "true"` · 2/12
- Notes: „Band 11 (DE) erschienen 23.03.2026. Serie nähert sich dem Abschluss.“
- Bewertung: ✅

### adabana (Tokyopop)
- Aktuell: `ongoing: "false"` · 3/3
- Notes: „Abgeschlossen, 3 Bände.“
- Bewertung: ✅

### Isekai Soapland (MangaMoon)
- Aktuell: `ongoing: "true"` · 1/8
- Notes: „Band 1 April 2026, Band 2: 31.07.2026. JP 8+ Bände.“
- Bewertung: ✅

---

## Zusammenfassung

- Geprüfte Seeds: 53
- ✅ unverändert konsistent: 45
- ⚠️ konsistent, aber bei nächster Pflege gegen Verlagsprogramm prüfen: 6
  (Tokyo Revengers DB-Edition, Mujina, Yandere Dark Elf, Die letzte Elfe,
  Blood Blade, Sakura/Pearls separate Edition)
- 🔁 unter Phase-38-Semantik fragwürdig, manuelle Pflege empfohlen
  (Empfehlung: `unknown` nach offizieller Verlagsquelle): 3
  (Vagabond Master Edition, Kijin Gentosho, Real Account)
- Automatisch geänderte Werte: **0**
  (Phase 38 erlaubt keine Statusänderungen ohne belastbare Verlagsquelle.)

## Bestätigungen

- Es wurden **keine** Besitz-, Lese- oder Banddaten verändert (`bands`, `owned`,
  `current`, `status`, `startedAt`, `finishedAt` bleiben unangetastet).
- Es wurden **keine** Release-Cache-Einträge manuell befüllt.
- Es wurden **keine** Statuswerte geraten – unklare Fälle sind oben als 🔁/⚠️ markiert
  und für die nächste Pflege dokumentiert.
- Es wurden **keine** Supabase-Schema-Änderungen vorgenommen.
- Es wurden **keine** privaten Sammlungsdaten in dieses Dokument übernommen.

## Folgeaufgaben (für spätere Pflege, nicht Teil dieser Phase)

1. 🔁-Fälle gegen die jeweilige Verlagsseite prüfen und bei Bedarf `ongoing`
   auf `unknown` oder den jeweils belegten Wert setzen.
2. ⚠️-Fälle nach Erscheinen des jeweils nächsten DE-Bandes erneut prüfen.
3. Optional in einer späteren Phase ein separates Feld
   `originalPublicationStatus` einführen, falls die Information getrennt vom
   DE-Status persistiert werden soll.
