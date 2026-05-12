#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SOURCES_PATH = path.join(ROOT, "data", "release-sources.json");
const CACHE_PATH = path.join(ROOT, "data", "release-cache.json");
const REQUEST_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = "Manga-Tracker release-cache updater (https://github.com/sharkonek/manga-tracker)";

const publisherAliases = {
  "carlsen manga": "carlsen",
  "carlsen manga!": "carlsen",
  "carlsen verlag": "carlsen",
  tokyopop: "tokyopop_de",
  "tokyopop deutschland": "tokyopop_de",
  egmont: "egmont",
  "egmont manga": "egmont",
  "manga cult": "manga_cult",
  altraverse: "altraverse",
  panini: "panini_de",
  "panini manga": "panini_de",
  "panini deutschland": "panini_de",
  "cross cult": "cross_cult",
  "cross cult manga": "cross_cult",
  "kaze manga": "crunchyroll",
  "kazé manga": "crunchyroll",
  crunchyroll: "crunchyroll",
};

async function main() {
  const sourcesFile = await readJson(SOURCES_PATH, { schemaVersion: 1, sources: [] });
  validateSourcesFile(sourcesFile);

  const previousCache = await readJson(CACHE_PATH, null);
  const items = [];
  const warnings = [];

  for (const source of sourcesFile.sources) {
    try {
      const found = await collectSource(source);
      items.push(...found);
    } catch (error) {
      warnings.push(`${source.seriesTitle || source.mangaPassionUrl}: ${error.message}`);
    }
  }

  const deduped = dedupeItems(items).sort(compareItems);
  if (!deduped.length && sourcesFile.sources.length > 0) {
    throw new Error(`Keine Release-Daten extrahiert. Warnungen: ${warnings.join(" | ")}`);
  }

  const previousItems = Array.isArray(previousCache?.items) ? previousCache.items : [];
  const itemsChanged = stableStringify(previousItems) !== stableStringify(deduped);
  const cache = {
    schemaVersion: 1,
    generatedAt: itemsChanged ? new Date().toISOString() : previousCache?.generatedAt || null,
    source: "manga-passion",
    itemCount: deduped.length,
    items: deduped,
  };

  if (!itemsChanged && previousCache) {
    console.log("release-cache.json ist unveraendert.");
    if (warnings.length) console.warn(warnings.join("\n"));
    return;
  }

  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  console.log(`release-cache.json geschrieben: ${deduped.length} Eintraege.`);
  if (warnings.length) console.warn(warnings.join("\n"));
}

async function collectSource(source) {
  const sourceUrl = normalizeUrl(source.mangaPassionUrl);
  if (sourceUrl.includes("/volumes/")) {
    return [await fetchAndParseVolume(sourceUrl, source)];
  }

  if (sourceUrl.includes("/editions/")) {
    const html = await fetchPage(sourceUrl);
    const volumeUrls = extractVolumeUrls(html);
    const items = [];
    for (const volumeUrl of volumeUrls) {
      await delay(REQUEST_DELAY_MS);
      items.push(await fetchAndParseVolume(volumeUrl, source));
    }
    return items;
  }

  throw new Error("Nur Manga-Passion edition- oder volume-URLs sind erlaubt.");
}

async function fetchAndParseVolume(url, source) {
  const html = await fetchPage(url);
  const item = parseVolumePage(html, url, source);
  validateItem(item, url);
  return item;
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fuer ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseVolumePage(html, sourceUrl, source) {
  const title = decodeHtml(extractMeta(html, "og:title") || extractFirst(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i));
  const text = htmlToText(html);
  const volumeNumber = positiveInteger(extractFirst(title, /Band\s+(\d+)/i) || extractFirst(text, /Band\s+(\d+)/i));
  const publisher = normalizePublisher(extractInfoValue(html, "Verlag") || source.publisher || "");
  const releaseDate = normalizeReleaseDate(extractInfoValue(html, "Veröffentlichung"));
  const isbn13 = normalizeIsbn13(extractInfoValue(html, "ISBN"));
  const coverUrl = decodeHtml(extractMeta(html, "og:image") || extractMeta(html, "twitter:image"));
  const editionType = normalizeEditionType(source.editionType || "", title);
  const seriesTitle = String(source.seriesTitle || stripVolumeSuffix(title)).trim();

  return {
    seriesTitle,
    volumeNumber,
    publisher,
    releaseDate,
    isbn13,
    coverUrl,
    editionType,
    sourceUrl,
    confidence: calculateConfidence({ seriesTitle, volumeNumber, publisher, releaseDate, isbn13, coverUrl, sourceUrl }),
  };
}

function extractVolumeUrls(html) {
  const urls = new Set();
  const pattern = /href="(\/volumes\/[^"#?]+)"/g;
  let match = pattern.exec(html);
  while (match) {
    urls.add(normalizeUrl(match[1]));
    match = pattern.exec(html);
  }
  return Array.from(urls).sort();
}

function extractInfoValue(html, label) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<span[^>]*>${escapedLabel}<\\/span>\\s*<span[^>]*>([\\s\\S]*?)<\\/span>`, "i");
  const match = html.match(pattern);
  return match ? decodeHtml(stripTags(match[1])).trim() : "";
}

function extractMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return "";
}

function extractFirst(value, pattern) {
  const match = String(value || "").match(pattern);
  return match ? match[1] : "";
}

function htmlToText(html) {
  return decodeHtml(stripTags(String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ")));
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripVolumeSuffix(title) {
  return String(title || "")
    .replace(/\s*[,–-]?\s*Band\s+\d+.*$/i, "")
    .replace(/\s*\(eBook\)\s*/i, "")
    .trim();
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("mangaPassionUrl fehlt.");
  const url = raw.startsWith("/") ? new URL(raw, "https://www.manga-passion.de") : new URL(raw);
  if (url.hostname !== "www.manga-passion.de" && url.hostname !== "manga-passion.de") {
    throw new Error(`Nicht erlaubte Quelle: ${url.hostname}`);
  }
  url.hash = "";
  url.search = "";
  return url.toString();
}

function normalizePublisher(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  return publisherAliases[normalized] || normalized || "other";
}

function normalizeIsbn13(value) {
  const digits = String(value || "").replace(/[^0-9Xx]/g, "");
  return /^\d{13}$/.test(digits) ? digits : "";
}

function normalizeReleaseDate(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{1,2})\.\s*([A-Za-zÄÖÜäöüß]+)\s+(\d{4})$/);
  const months = {
    januar: "01",
    februar: "02",
    marz: "03",
    maerz: "03",
    april: "04",
    mai: "05",
    juni: "06",
    juli: "07",
    august: "08",
    september: "09",
    oktober: "10",
    november: "11",
    dezember: "12",
  };
  if (!match) return "";
  const monthKey = match[2].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const month = months[monthKey];
  return month ? `${match[3]}-${month}-${match[1].padStart(2, "0")}` : "";
}

function normalizeEditionType(value, title) {
  const haystack = `${value || ""} ${title || ""}`.toLowerCase();
  if (/\bbox\s*set\b|\bboxset\b|\bschuber\b/.test(haystack)) return "boxset";
  if (/\blimited\b|\bsonderausgabe\b/.test(haystack)) return "limited";
  if (/\bcollector\b|\bcollectors\b|\bcollector'?s\b/.test(haystack)) return "collector";
  if (/\bdeluxe\b/.test(haystack)) return "deluxe";
  return "standard";
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function calculateConfidence(item) {
  let score = 30;
  if (item.seriesTitle) score += 15;
  if (item.volumeNumber) score += 20;
  if (item.publisher && item.publisher !== "other") score += 10;
  if (item.releaseDate) score += 10;
  if (item.isbn13) score += 10;
  if (item.coverUrl) score += 5;
  return Math.min(100, score);
}

function validateSourcesFile(file) {
  if (file.schemaVersion !== 1) throw new Error("release-sources.json braucht schemaVersion 1.");
  if (!Array.isArray(file.sources)) throw new Error("release-sources.json braucht ein sources-Array.");
}

function validateItem(item, url) {
  const errors = [];
  if (!item.seriesTitle) errors.push("seriesTitle fehlt");
  if (!item.volumeNumber) errors.push("volumeNumber fehlt");
  if (!item.publisher) errors.push("publisher fehlt");
  if (!item.releaseDate) errors.push("releaseDate fehlt");
  if (!item.sourceUrl) errors.push("sourceUrl fehlt");
  if (errors.length) throw new Error(`${url}: ${errors.join(", ")}`);
}

function dedupeItems(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.sourceUrl || [item.publisher, item.seriesTitle, item.volumeNumber, item.editionType, item.isbn13].join("|");
    map.set(key, item);
  }
  return Array.from(map.values());
}

function compareItems(a, b) {
  return a.seriesTitle.localeCompare(b.seriesTitle, "de")
    || a.volumeNumber - b.volumeNumber
    || a.editionType.localeCompare(b.editionType, "de")
    || a.sourceUrl.localeCompare(b.sourceUrl, "de");
}

function stableStringify(value) {
  return JSON.stringify(value, Object.keys(flattenKeys(value)).sort());
}

function flattenKeys(value, keys = {}) {
  if (Array.isArray(value)) value.forEach((item) => flattenKeys(item, keys));
  else if (value && typeof value === "object") {
    Object.keys(value).forEach((key) => {
      keys[key] = true;
      flattenKeys(value[key], keys);
    });
  }
  return keys;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
