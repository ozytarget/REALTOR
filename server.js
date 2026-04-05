require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const PDFDocument = require("pdfkit");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const TAX_RATE = 0.078;

const uploadsBaseDir = path.join(__dirname, "uploads");
const PRICING_PATH = path.join(__dirname, "data", "pricing.json");
const LOGO_PATH = path.join(__dirname, "public", "assets", "a-pro-handyman-llc.jpeg");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const geminiClient = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
if (!fs.existsSync(uploadsBaseDir)) {
    fs.mkdirSync(uploadsBaseDir, { recursive: true });
}

const DEFAULT_PRICING = {
    regions: {
        DEFAULT: { laborMultiplier: 1.0, materialMultiplier: 1.0 }
    },
    items: {
        general_repair: {
            label: "General Repair Allowance",
            material: 600,
            labor: 900,
            critical: false
        }
    }
};

const PRICING = loadPricing();

function parseCookies(header) {
    const raw = String(header || "");
    return raw.split(";").reduce((acc, part) => {
        const [key, ...valueParts] = part.trim().split("=");
        if (!key) {
            return acc;
        }
        acc[key] = decodeURIComponent(valueParts.join("=") || "");
        return acc;
    }, {});
}

function sanitizeSessionId(value) {
    return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function createSessionId() {
    if (crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureSession(req, res) {
    const cookies = parseCookies(req.headers.cookie || "");
    let sessionId = sanitizeSessionId(cookies.realtor_session);

    if (!sessionId) {
        sessionId = createSessionId();
        res.setHeader(
            "Set-Cookie",
            `realtor_session=${sessionId}; Path=/; SameSite=Lax; Max-Age=86400`
        );
    }

    const sessionDir = path.join(uploadsBaseDir, sessionId);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    return { sessionId, sessionDir };
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const sessionDir = req.sessionDir || uploadsBaseDir;
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        cb(null, sessionDir);
    },
    filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        cb(null, `${stamp}-${safeName}`);
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const isPdf =
            file.mimetype === "application/pdf" ||
            file.originalname.toLowerCase().endsWith(".pdf");

        if (!isPdf) {
            return cb(new Error("Only PDF files are allowed."));
        }

        return cb(null, true);
    },
    limits: {
        fileSize: 50 * 1024 * 1024
    }
});

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
    const { sessionId, sessionDir } = ensureSession(req, res);
    req.sessionId = sessionId;
    req.sessionDir = sessionDir;
    next();
});
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/upload", upload.single("report"), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
    }

    const reportEntry = storeReportIndexEntry(req.sessionDir, req.file);

    return res.json({
        ok: true,
        report: reportEntry
    });
});

app.get("/api/reports", (req, res) => {
    try {
        const index = loadReportIndex(req.sessionDir);
        const reports = index
            .map((entry) => {
                const filePath = path.join(req.sessionDir, entry.storedName);
                if (!fs.existsSync(filePath)) {
                    return null;
                }
                const stats = fs.statSync(filePath);
                return {
                    id: entry.id,
                    name: entry.originalName,
                    storedName: entry.storedName,
                    size: stats.size,
                    uploadedAt: entry.uploadedAt,
                    url: `/api/reports/${encodeURIComponent(entry.storedName)}`,
                    downloadUrl: `/api/reports/download/${encodeURIComponent(entry.id)}`
                };
            })
            .filter(Boolean);

        res.json({ reports });
    } catch (error) {
        res.status(500).json({ error: "Unable to read reports." });
    }
});

app.get("/api/reports/:file", (req, res) => {
    const safeName = path.basename(req.params.file || "");

    if (!safeName.toLowerCase().endsWith(".pdf")) {
        return res.status(400).json({ error: "Invalid file type." });
    }

    const filePath = path.join(req.sessionDir, safeName);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found." });
    }

    return res.download(filePath);
});

app.get("/api/reports/download/:id", (req, res) => {
    const reportId = String(req.params.id || "").trim();
    const entry = findReportEntry(req.sessionDir, reportId);

    if (!entry) {
        return res.status(404).json({ error: "Report not found." });
    }

    const filePath = path.join(req.sessionDir, entry.storedName);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found." });
    }

    return res.download(filePath, entry.originalName || entry.storedName);
});

app.post("/api/session/cleanup", (req, res) => {
    const sessionDir = req.sessionDir;
    try {
        if (sessionDir && fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    } catch (error) {
        return res.status(500).json({ error: "Unable to clear session data." });
    }

    res.setHeader(
        "Set-Cookie",
        "realtor_session=; Path=/; Max-Age=0; SameSite=Lax"
    );
    return res.json({ ok: true });
});

app.post("/api/estimate", async (req, res) => {
    try {
        const payload = req.body || {};
        const estimate = await buildEstimate(payload, req.sessionDir);
        res.json(estimate);
    } catch (error) {
        res.status(500).json({ error: error.message || "Unable to generate estimate." });
    }
});

app.post("/api/estimate/pdf", (req, res) => {
    try {
        const estimate = req.body;
        if (!estimate || !estimate.estimateId) {
            return res.status(400).json({ error: "Estimate payload is required." });
        }

        return generateEstimatePdf(estimate, res);
    } catch (error) {
        return res.status(500).json({ error: "Unable to generate PDF." });
    }
});

app.use((err, req, res, next) => {
    if (err && err.message) {
        return res.status(400).json({ error: err.message });
    }

    return res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

const STATE_CODES = new Set([
    "AL",
    "AK",
    "AZ",
    "AR",
    "CA",
    "CO",
    "CT",
    "DE",
    "FL",
    "GA",
    "HI",
    "ID",
    "IL",
    "IN",
    "IA",
    "KS",
    "KY",
    "LA",
    "ME",
    "MD",
    "MA",
    "MI",
    "MN",
    "MS",
    "MO",
    "MT",
    "NE",
    "NV",
    "NH",
    "NJ",
    "NM",
    "NY",
    "NC",
    "ND",
    "OH",
    "OK",
    "OR",
    "PA",
    "RI",
    "SC",
    "SD",
    "TN",
    "TX",
    "UT",
    "VT",
    "VA",
    "WA",
    "WV",
    "WI",
    "WY"
]);

const REGION_DEFAULT = DEFAULT_PRICING.regions.DEFAULT;

const REPAIR_CATALOG = {
    roof: { label: "Roofing Repairs", material: 1400, labor: 1900 },
    plumbing: { label: "Plumbing Repairs", material: 520, labor: 760 },
    electrical: { label: "Electrical Repairs", material: 460, labor: 710 },
    drywall: { label: "Drywall and Trim", material: 320, labor: 520 },
    paint: { label: "Paint and Finish", material: 280, labor: 430 },
    flooring: { label: "Flooring Repairs", material: 960, labor: 1180 },
    hvac: { label: "HVAC Repairs", material: 1500, labor: 2200 },
    windows: { label: "Windows and Doors", material: 820, labor: 980 },
    foundation: { label: "Foundation Repairs", material: 1800, labor: 2600 },
    exterior: { label: "Exterior Repairs", material: 740, labor: 1020 },
    general: { label: "General Repairs", material: 600, labor: 900 }
};

async function buildEstimate(payload, sessionDir) {
    const baseLocation = resolveLocation(payload);
    const requestedReport = payload.reportId ? findReportEntry(sessionDir, payload.reportId) : null;
    const fallbackReport = !requestedReport && !payload.summary
        ? getLatestReportEntry(sessionDir)
        : null;
    const reportEntry = requestedReport || fallbackReport;
    const hasAnalysisInput = Boolean(payload.summary || reportEntry);
    const analysis = hasAnalysisInput
        ? await analyzeInspection({ reportEntry, summary: payload.summary, location: baseLocation, sessionDir })
        : buildEmptyAnalysis();
    const location = mergeLocations(baseLocation, analysis.location);
    const regionProfile = getRegionProfile(location.state);

    const lineItems = analysis.repairs.length > 0
        ? buildLineItemsFromRepairs(analysis.repairs, regionProfile)
        : buildLineItemsFromAreas(resolveAreas(payload), regionProfile);

    const criticalItems = lineItems.filter((item) => item.critical);
    const additionalItems = lineItems.filter((item) => !item.critical);
    const subtotal = lineItems.reduce((sum, item) => sum + item.total, 0);
    const tax = Math.round(subtotal * TAX_RATE);
    const total = subtotal + tax;

    const assumptions = [
        "Material pricing uses regional Home Depot retail averages (placeholder).",
        "Labor pricing uses regional average contractor rates.",
        "Final scope and pricing confirmed after onsite review."
    ];

    if (analysis.source === "gemini") {
        assumptions.push("Automated extraction used to map inspector report to repair items.");
    } else if (analysis.source === "heuristic" && analysis.reportId) {
        assumptions.push("Rule-based extraction used for the inspector report.");
    }

    if (fallbackReport) {
        assumptions.push("Latest uploaded report used because no report ID was provided.");
    }

    if (!location.addressLine || location.addressLine === "(Address pending)") {
        assumptions.push("Property address not detected in the report.");
    }

    return {
        estimateId: `EST-${Date.now()}`,
        createdAt: new Date().toISOString(),
        company: "A PRO HANDYMAN LLC",
        contractor: "Oscar Urbina",
        location,
        reportId: analysis.reportId || payload.reportId || "",
        reportName: analysis.reportName || "",
        propertyType: payload.propertyType || "Single Family",
        analysis,
        lineItems,
        criticalItems,
        additionalItems,
        totals: {
            subtotal,
            tax,
            total
        },
        taxRate: TAX_RATE,
        assumptions,
        notes: payload.summary ? ["Inspection summary provided."] : []
    };
}

function getLatestReportEntry(sessionDir) {
    const index = loadReportIndex(sessionDir);
    return index.length ? index[0] : null;
}

function mergeLocations(baseLocation, overrideLocation) {
    const override = normalizeLocation(overrideLocation);
    const base = normalizeLocation(baseLocation);
    const addressLine = override.addressLine || base.addressLine || "(Address pending)";

    return {
        addressLine,
        city: override.city || base.city || "",
        state: override.state || base.state || "",
        zip: override.zip || base.zip || ""
    };
}

function normalizeLocation(location) {
    if (!location) {
        return { addressLine: "", city: "", state: "", zip: "" };
    }

    return {
        addressLine: normalizeAddressValue(location.addressLine),
        city: String(location.city || "").trim(),
        state: String(location.state || "").trim().toUpperCase(),
        zip: String(location.zip || "").trim()
    };
}

function normalizeAddressValue(value) {
    const normalized = String(value || "").trim();
    if (!normalized || normalized === "(Address pending)") {
        return "";
    }

    return normalized;
}

function buildEmptyAnalysis() {
    return {
        source: "manual",
        summary: "",
        criticalSummary: "",
        repairs: [],
        warnings: [],
        location: null,
        reportId: "",
        reportName: ""
    };
}

function getRegionProfile(state) {
    const regions = PRICING.regions || DEFAULT_PRICING.regions;
    return regions[state] || regions.DEFAULT || REGION_DEFAULT;
}

function buildLineItemsFromAreas(areas, regionProfile) {
    const materialMultiplier = regionProfile.materialMultiplier || 1;
    const laborMultiplier = regionProfile.laborMultiplier || 1;

    return areas.map((area) => {
        const catalogEntry = REPAIR_CATALOG[area] || REPAIR_CATALOG.general;
        const material = Math.round(catalogEntry.material * materialMultiplier);
        const labor = Math.round(catalogEntry.labor * laborMultiplier);

        return {
            area,
            description: catalogEntry.label,
            material,
            labor,
            total: material + labor,
            critical: false
        };
    });
}

function buildLineItemsFromRepairs(repairs, regionProfile) {
    const materialMultiplier = regionProfile.materialMultiplier || 1;
    const laborMultiplier = regionProfile.laborMultiplier || 1;
    const itemsCatalog = PRICING.items || DEFAULT_PRICING.items;
    const unique = new Map();

    repairs.forEach((repair) => {
        const itemKey = normalizeRepairKey(repair);
        if (!unique.has(itemKey)) {
            unique.set(itemKey, { ...repair, itemKey });
        }
    });

    return Array.from(unique.values()).map((repair) => {
        const pricingItem = itemsCatalog[repair.itemKey] || itemsCatalog.general_repair;
        const material = Math.round(pricingItem.material * materialMultiplier);
        const labor = Math.round(pricingItem.labor * laborMultiplier);
        const notes = repair.notes || pricingItem.notes || "";
        const parts = Array.isArray(repair.parts)
            ? repair.parts
            : Array.isArray(pricingItem.parts)
                ? pricingItem.parts
                : [];

        return {
            area: repair.itemKey,
            description: pricingItem.label,
            material,
            labor,
            total: material + labor,
            critical: Boolean(repair.critical || pricingItem.critical),
            notes,
            parts
        };
    });
}

function normalizeRepairKey(repair) {
    if (repair.itemKey) {
        return repair.itemKey;
    }

    const system = String(repair.system || "").toLowerCase();
    const action = String(repair.action || "").toLowerCase();

    if (system.includes("water") && system.includes("heater")) {
        return action === "replace" ? "water_heater_replace" : "water_heater_repair";
    }

    if (system.includes("roof")) return "roof_leak";
    if (system.includes("plumb")) return "plumbing_leak";
    if (system.includes("elect")) return "electrical_hazard";
    if (system.includes("hvac") || system.includes("air")) return "hvac_service";
    if (system.includes("foundation")) return "foundation_crack";

    return "general_repair";
}

async function analyzeInspection({ reportEntry, summary, location, sessionDir }) {
    const analysis = buildEmptyAnalysis();
    const warnings = [];
    let pdfBuffer = null;
    let pdfText = "";

    if (reportEntry) {
        const activeDir = sessionDir || uploadsBaseDir;
        const filePath = path.join(activeDir, reportEntry.storedName);
        if (fs.existsSync(filePath)) {
            pdfBuffer = fs.readFileSync(filePath);
            pdfText = await extractPdfText(pdfBuffer);
        }
    }

    const combinedText = [summary, pdfText].filter(Boolean).join("\n").trim();
    let result = extractFindingsFromText(combinedText);
    let source = "heuristic";

    const locationFromText = extractLocationFromText(combinedText);
    if (locationFromText) {
        result.location = locationFromText;
    }

    if (!result.summary && combinedText) {
        result.summary = combinedText.slice(0, 240).trim();
    }

    if (geminiClient && pdfBuffer) {
        const aiResult = await analyzeWithGemini({
            buffer: pdfBuffer,
            summary,
            location
        });
        if (aiResult && aiResult.repairs.length > 0) {
            if (!aiResult.location && result.location) {
                aiResult.location = result.location;
            }
            result = aiResult;
            source = "gemini";
        }
    } else if (pdfBuffer && pdfText.trim().length < 40) {
        warnings.push("PDF appears scanned. Configure GEMINI_API_KEY to enable OCR.");
    }

    return {
        ...analysis,
        ...result,
        source,
        warnings,
        reportId: reportEntry ? reportEntry.id : "",
        reportName: reportEntry ? reportEntry.originalName : ""
    };
}

async function extractPdfText(buffer) {
    try {
        const data = await pdfParse(buffer);
        return String(data.text || "").trim();
    } catch (error) {
        return "";
    }
}

function extractLocationFromText(text) {
    if (!text) {
        return null;
    }

    const lines = String(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    let streetCandidate = "";

    for (const rawLine of lines) {
        const line = rawLine.replace(/\s+/g, " ").trim();
        const labeledLine = line.replace(/^(property address|property|address|location)\s*[:#-]\s*/i, "");

        const fullMatch = parseAddressFromLine(labeledLine) || parseAddressFromLine(line);
        if (fullMatch) {
            return fullMatch;
        }

        const cityStateZip =
            parseCityStateZipFromLine(labeledLine) || parseCityStateZipFromLine(line);
        if (cityStateZip) {
            if (streetCandidate) {
                return {
                    addressLine: `${streetCandidate}, ${cityStateZip.city}, ${cityStateZip.state} ${cityStateZip.zip}`,
                    city: cityStateZip.city,
                    state: cityStateZip.state,
                    zip: cityStateZip.zip
                };
            }

            return {
                addressLine: "",
                city: cityStateZip.city,
                state: cityStateZip.state,
                zip: cityStateZip.zip
            };
        }

        if (!streetCandidate) {
            const streetOnly = parseStreetLine(labeledLine) || parseStreetLine(line);
            if (streetOnly) {
                streetCandidate = streetOnly;
            }
        }
    }

    return null;
}

function parseAddressFromLine(line) {
    const addressRegex =
        /^(\d{1,6}\s+[A-Za-z0-9.\-#'\s]+?),?\s+([A-Za-z.\-\s']+),?\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/i;
    const match = String(line || "").trim().match(addressRegex);
    if (!match) {
        return null;
    }

    const street = match[1].trim();
    const city = match[2].trim();
    const state = match[3].trim().toUpperCase();
    const zip = match[4].trim();

    if (!STATE_CODES.has(state)) {
        return null;
    }

    return {
        addressLine: `${street}, ${city}, ${state} ${zip}`,
        city,
        state,
        zip
    };
}

function parseCityStateZipFromLine(line) {
    const cityStateZipRegex = /([A-Za-z.\-\s']+),?\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?/i;
    const match = String(line || "").trim().match(cityStateZipRegex);
    if (!match) {
        return null;
    }

    const state = match[2].trim().toUpperCase();
    if (!STATE_CODES.has(state)) {
        return null;
    }

    return {
        city: match[1].trim(),
        state,
        zip: match[3].trim()
    };
}

function parseStreetLine(line) {
    const cleaned = String(line || "").trim();
    if (!/^\d{1,6}\s+[A-Za-z0-9.\-#'\s]+$/.test(cleaned)) {
        return "";
    }

    return cleaned;
}

function extractFindingsFromText(text) {
    const repairs = [];
    const summaryParts = [];
    const criticalParts = [];
    const lower = String(text || "").toLowerCase();

    if (!lower) {
        return { repairs: [], summary: "", criticalSummary: "" };
    }

    const hasWaterHeater = /water\s*heater|waterheater/.test(lower);
    if (hasWaterHeater) {
        const replaceIndicators = [
            "replace",
            "replacement",
            "leak",
            "corrosion",
            "rust",
            "failed",
            "not working"
        ];
        const repairIndicators = [
            "valve",
            "thermostat",
            "pressure relief",
            "pilot",
            "element"
        ];

        const shouldReplace = replaceIndicators.some((word) => lower.includes(word));
        const canRepair = repairIndicators.some((word) => lower.includes(word));
        const action = shouldReplace || !canRepair ? "replace" : "repair";

        repairs.push({
            itemKey: action === "replace" ? "water_heater_replace" : "water_heater_repair",
            system: "water heater",
            action,
            issue: "Water heater requires attention.",
            critical: action === "replace" || lower.includes("leak")
        });

        summaryParts.push("Water heater issue detected.");
        if (action === "replace") {
            criticalParts.push("Water heater replacement recommended.");
        }
    }

    if (lower.includes("roof") && /(leak|damage|missing|shingle)/.test(lower)) {
        repairs.push({
            itemKey: "roof_leak",
            system: "roof",
            action: "repair",
            issue: "Roof leak or damage reported.",
            critical: true
        });
        summaryParts.push("Roof issue detected.");
        criticalParts.push("Roof leak requires attention.");
    }

    if (/plumb|pipe|leak/.test(lower)) {
        repairs.push({
            itemKey: "plumbing_leak",
            system: "plumbing",
            action: "repair",
            issue: "Plumbing leak reported.",
            critical: lower.includes("leak")
        });
        summaryParts.push("Plumbing issue detected.");
    }

    if (/electrical|panel|wiring/.test(lower) && /(hazard|unsafe|overheat|exposed)/.test(lower)) {
        repairs.push({
            itemKey: "electrical_hazard",
            system: "electrical",
            action: "repair",
            issue: "Electrical safety concern reported.",
            critical: true
        });
        summaryParts.push("Electrical safety issue detected.");
        criticalParts.push("Electrical hazard requires attention.");
    }

    if (/hvac|air condition|ac unit|furnace/.test(lower)) {
        repairs.push({
            itemKey: "hvac_service",
            system: "hvac",
            action: "service",
            issue: "HVAC service noted.",
            critical: false
        });
        summaryParts.push("HVAC issue detected.");
    }

    if (/foundation|settlement|crack/.test(lower)) {
        repairs.push({
            itemKey: "foundation_crack",
            system: "foundation",
            action: "repair",
            issue: "Foundation movement or cracking reported.",
            critical: true
        });
        summaryParts.push("Foundation issue detected.");
        criticalParts.push("Foundation repair recommended.");
    }

    const deduped = dedupeRepairs(repairs);

    return {
        repairs: deduped,
        summary: summaryParts.join(" ").trim(),
        criticalSummary: criticalParts.join(" ").trim()
    };
}

function dedupeRepairs(repairs) {
    const map = new Map();
    repairs.forEach((repair) => {
        const key = normalizeRepairKey(repair);
        if (!map.has(key)) {
            map.set(key, { ...repair, itemKey: key });
        }
    });
    return Array.from(map.values());
}

async function analyzeWithGemini({ buffer, summary, location }) {
    if (!geminiClient || !buffer) {
        return null;
    }

    try {
        const model = geminiClient.getGenerativeModel({ model: GEMINI_MODEL });
        const prompt = [
            "You are a repair estimator.",
            "Read the inspector report and return ONLY JSON.",
            "Schema: { summary: string, criticalSummary: string, location: { addressLine, city, state, zip }, repairs: [{ itemKey, issue, action, critical, parts }] }",
            "If the property address is present, fill location fields. Otherwise use empty strings.",
            "Allowed itemKey values: water_heater_replace, water_heater_repair, roof_leak, plumbing_leak, electrical_hazard, hvac_service, foundation_crack, general_repair.",
            "If the water heater is leaking, corroded, failed, or not working, use water_heater_replace.",
            "If the water heater needs a valve, thermostat, or relief part, use water_heater_repair.",
            "Mark critical true for safety hazards or active water intrusion.",
            "Use English."
        ].join("\n");

        const parts = [
            { text: prompt },
            {
                inlineData: {
                    data: buffer.toString("base64"),
                    mimeType: "application/pdf"
                }
            }
        ];

        if (summary) {
            parts.push({ text: `Inspector summary: ${summary}` });
        }
        if (location && location.state) {
            parts.push({ text: `Property state: ${location.state}` });
        }

        const result = await model.generateContent(parts);
        const text = result.response.text();
        const parsed = parseGeminiJson(text);
        return normalizeGeminiResult(parsed);
    } catch (error) {
        return null;
    }
}

function parseGeminiJson(text) {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) {
        return null;
    }

    try {
        return JSON.parse(match[0]);
    } catch (error) {
        return null;
    }
}

function normalizeGeminiResult(raw) {
    if (!raw || !Array.isArray(raw.repairs)) {
        return null;
    }

    const normalizedLocation = normalizeLocation(raw.location);
    const hasLocation =
        normalizedLocation.addressLine ||
        normalizedLocation.city ||
        normalizedLocation.state ||
        normalizedLocation.zip;
    const repairs = raw.repairs.map((repair) => ({
        itemKey: normalizeRepairKey(repair),
        issue: String(repair.issue || "").trim(),
        action: String(repair.action || "").trim(),
        critical: Boolean(repair.critical),
        parts: Array.isArray(repair.parts) ? repair.parts : []
    }));

    return {
        summary: String(raw.summary || "").trim(),
        criticalSummary: String(raw.criticalSummary || "").trim(),
        repairs: dedupeRepairs(repairs),
        location: hasLocation ? normalizedLocation : null
    };
}

function loadReportIndex(sessionDir) {
    try {
        const activeDir = sessionDir || uploadsBaseDir;
        const reportIndexPath = getReportIndexPath(activeDir);
        if (!fs.existsSync(reportIndexPath)) {
            const files = fs
                .readdirSync(activeDir)
                .filter((name) => name.toLowerCase().endsWith(".pdf"));

            if (files.length === 0) {
                return [];
            }

            const index = files.map((name) => {
                const stats = fs.statSync(path.join(activeDir, name));
                return {
                    id: createReportId(),
                    storedName: name,
                    originalName: name,
                    uploadedAt: stats.mtime.toISOString()
                };
            });

            saveReportIndex(activeDir, index);
            return index;
        }
        const raw = fs.readFileSync(reportIndexPath, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function saveReportIndex(sessionDir, index) {
    const reportIndexPath = getReportIndexPath(sessionDir);
    fs.writeFileSync(reportIndexPath, JSON.stringify(index, null, 2));
}

function createReportId() {
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `REP-${Date.now()}-${suffix}`;
}

function getReportIndexPath(sessionDir) {
    return path.join(sessionDir, "report-index.json");
}

function storeReportIndexEntry(sessionDir, file) {
    const index = loadReportIndex(sessionDir);
    const entry = {
        id: createReportId(),
        storedName: file.filename,
        originalName: file.originalname,
        uploadedAt: new Date().toISOString()
    };

    index.unshift(entry);
    saveReportIndex(sessionDir, index);
    return entry;
}

function findReportEntry(sessionDir, reportId) {
    if (!reportId) return null;
    const normalized = reportId.trim().toLowerCase();
    const index = loadReportIndex(sessionDir);

    return (
        index.find((entry) => entry.id.toLowerCase() === normalized) ||
        index.find((entry) => entry.storedName.toLowerCase() === normalized) ||
        index.find((entry) => entry.originalName.toLowerCase().includes(normalized)) ||
        null
    );
}

function generateEstimatePdf(estimate, res) {
    const filename = sanitizeFilename(`estimate-${estimate.estimateId}.pdf`);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ margin: 40, size: "LETTER" });
    doc.pipe(res);

    const headerTop = doc.y;
    const leftX = doc.page.margins.left;
    const rightX = doc.page.width - doc.page.margins.right;
    const headerWidth = 200;
    let headerHeight = 60;
    let textStartX = leftX;
    const availableWidth = rightX - leftX;
    const contentWidth = Math.min(480, availableWidth);
    const centeredLeft = leftX + (availableWidth - contentWidth) / 2;

    if (fs.existsSync(LOGO_PATH)) {
        const logoWidth = 120;
        const logoHeight = 80;
        doc.image(LOGO_PATH, leftX, headerTop, {
            fit: [logoWidth, logoHeight]
        });
        textStartX = Math.max(centeredLeft, leftX + logoWidth + 16);
        headerHeight = Math.max(headerHeight, logoHeight);
    } else {
        textStartX = centeredLeft;
    }

    doc.fontSize(18).text("Estimate", rightX - headerWidth, headerTop, {
        width: headerWidth,
        align: "right"
    });
    doc.fontSize(10).text(`Estimate ID: ${estimate.estimateId}`, rightX - headerWidth, headerTop + 22, {
        width: headerWidth,
        align: "right"
    });
    doc.fontSize(10).text(`Issued: ${formatDate(estimate.createdAt)}`, rightX - headerWidth, headerTop + 38, {
        width: headerWidth,
        align: "right"
    });

    doc.fontSize(12).text(estimate.company || "A PRO HANDYMAN LLC", textStartX, headerTop, {
        width: contentWidth
    });
    let companyTextY = headerTop + 16;
    if (estimate.contractor) {
        doc.fontSize(10).text(`Contractor: ${estimate.contractor}`, textStartX, companyTextY, {
            width: contentWidth
        });
        companyTextY += 14;
    }
    doc.fontSize(10).text("Cell: 678-725-8896", textStartX, companyTextY, {
        width: contentWidth
    });
    companyTextY += 14;
    doc.fontSize(10).text("Email: proservices911@aol.com", textStartX, companyTextY, {
        width: contentWidth
    });
    companyTextY += 14;

    const headerBottom = Math.max(headerTop + headerHeight, companyTextY + 2);
    doc.y = headerBottom + 8;
    doc.moveTo(leftX, doc.y).lineTo(rightX, doc.y).strokeColor("#d9d9d9").stroke();
    doc.moveDown(0.6);

    const propertyAddress =
        estimate.location && estimate.location.addressLine && estimate.location.addressLine !== "(Address pending)"
            ? estimate.location.addressLine
            : "Address pending";
    const cityStateZip = formatCityStateZip(estimate.location || {});

    const contentX = centeredLeft;
    doc.fontSize(11).text("Property Details", contentX, doc.y, { width: contentWidth });
    doc.fontSize(10).text(propertyAddress, contentX, doc.y, { width: contentWidth });
    if (cityStateZip) {
        doc.fontSize(10).text(cityStateZip, contentX, doc.y, { width: contentWidth });
    }
    doc.moveDown(0.5);

    renderPdfSection(doc, "Critical Repairs", estimate.criticalItems || [], {
        x: contentX,
        width: contentWidth
    });
    renderPdfSection(doc, "Additional Repairs", estimate.additionalItems || [], {
        x: contentX,
        width: contentWidth
    });

    doc.moveDown(0.6);
    const totalsWidth = 220;
    const totalsX = rightX - totalsWidth;
    const totalsAmountWidth = 90;
    const totalsLabelWidth = totalsWidth - totalsAmountWidth;
    const totalsTop = doc.y;

    doc.lineWidth(0.5);
    doc.moveTo(totalsX, totalsTop).lineTo(rightX, totalsTop).strokeColor("#d9d9d9").stroke();
    doc.moveDown(0.4);

    doc.fontSize(11).text("Totals", totalsX, doc.y, { width: totalsWidth, align: "right" });
    doc.moveDown(0.2);

    const renderTotalRow = (label, value, bold) => {
        const rowY = doc.y;
        doc.fontSize(bold ? 11 : 10).text(label, totalsX, rowY, { width: totalsLabelWidth });
        doc.fontSize(bold ? 11 : 10).text(value, totalsX + totalsLabelWidth, rowY, {
            width: totalsAmountWidth,
            align: "right"
        });
        doc.moveDown(0.3);
        doc.moveTo(totalsX, doc.y).lineTo(rightX, doc.y).strokeColor("#ededed").stroke();
        doc.moveDown(0.2);
    };

    renderTotalRow("Subtotal", formatCurrency(estimate.totals.subtotal), false);
    renderTotalRow(`Tax (${(estimate.taxRate * 100).toFixed(1)}%)`, formatCurrency(estimate.totals.tax), false);
    renderTotalRow("Grand Total", formatCurrency(estimate.totals.total), true);

    doc.moveDown();
    doc.fontSize(11).text("Policy and Notes", contentX, doc.y, { width: contentWidth });
    doc.fontSize(9);
    [
        "Pricing is valid for 15 days from the issued date.",
        "Any additional work outside this scope requires written approval.",
        "Repairs follow the listed items and approved scope.",
        "Site conditions may require updates to the final scope."
    ].forEach((line) => {
        doc.text(`- ${line}`, contentX, doc.y, { width: contentWidth });
    });

    if (estimate.analysis && estimate.analysis.summary) {
        doc.moveDown();
        doc.fontSize(11).text("Report Findings", contentX, doc.y, { width: contentWidth });
        doc.fontSize(9).text(estimate.analysis.summary, contentX, doc.y, { width: contentWidth });
    }

    doc.end();
}

function renderPdfSection(doc, title, items, layout) {
    const contentX = layout && typeof layout.x === "number" ? layout.x : doc.page.margins.left;
    const contentWidth = layout && typeof layout.width === "number"
        ? layout.width
        : doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const amountWidth = 90;
    const descriptionWidth = Math.max(120, contentWidth - amountWidth - 10);

    doc.fontSize(12).text(title, contentX, doc.y, { underline: true, width: contentWidth });

    if (!items.length) {
        doc.fontSize(9).text("None listed.", contentX, doc.y, { width: contentWidth });
        doc.moveDown(0.5);
        return;
    }

    items.forEach((item) => {
        const startY = doc.y;
        const description = String(item.description || "");
        const descriptionHeight = doc.heightOfString(description, {
            width: descriptionWidth
        });

        doc.fontSize(10).text(description, contentX, startY, {
            width: descriptionWidth
        });
        doc.fontSize(10).text(formatCurrency(item.total), contentX + descriptionWidth, startY, {
            width: amountWidth,
            align: "right"
        });

        doc.y = startY + descriptionHeight;

        if (item.notes) {
            doc.fontSize(8).text(item.notes, contentX, doc.y, {
                width: descriptionWidth
            });
        }
        if (Array.isArray(item.parts) && item.parts.length > 0) {
            doc.fontSize(8).text(`Parts: ${item.parts.join(", ")}`, contentX, doc.y, {
                width: descriptionWidth
            });
        }
        doc.moveDown(0.4);
    });
}

function sanitizeFilename(value) {
    return String(value || "estimate")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 64);
}

const currencyFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
});

function formatCurrency(amount) {
    return currencyFormatter.format(Number(amount || 0));
}

function formatDate(value) {
    if (!value) {
        return "";
    }

    try {
        return new Date(value).toLocaleDateString("en-US");
    } catch (error) {
        return "";
    }
}

function formatCityStateZip(location) {
    if (!location) {
        return "";
    }

    const city = String(location.city || "").trim();
    const state = String(location.state || "").trim();
    const zip = String(location.zip || "").trim();
    const cityState = city && state ? `${city}, ${state}` : city || state;
    return [cityState, zip].filter(Boolean).join(" ");
}

function loadPricing() {
    try {
        if (!fs.existsSync(PRICING_PATH)) {
            return DEFAULT_PRICING;
        }

        const raw = fs.readFileSync(PRICING_PATH, "utf8");
        const parsed = JSON.parse(raw);

        return {
            regions: {
                ...DEFAULT_PRICING.regions,
                ...(parsed.regions || {})
            },
            items: {
                ...DEFAULT_PRICING.items,
                ...(parsed.items || {})
            }
        };
    } catch (error) {
        return DEFAULT_PRICING;
    }
}

function resolveLocation(payload) {
    const addressLine = String(payload.addressLine || "").trim();
    const inputCity = String(payload.city || "").trim();
    const inputState = String(payload.state || "").trim().toUpperCase();
    const zip = String(payload.zip || "").trim();

    const stateFromAddress = parseStateFromAddress(addressLine);
    const state = inputState || stateFromAddress || "GA";
    const city = inputCity || (addressLine ? parseCityFromAddress(addressLine, state) : "");

    return {
        addressLine: addressLine || "(Address pending)",
        city,
        state,
        zip: zip || ""
    };
}

function resolveAreas(payload) {
    if (Array.isArray(payload.repairAreas) && payload.repairAreas.length > 0) {
        return payload.repairAreas;
    }

    const summary = String(payload.summary || "").toLowerCase();
    const matched = [];

    if (summary.includes("roof")) matched.push("roof");
    if (summary.includes("plumb")) matched.push("plumbing");
    if (summary.includes("elect")) matched.push("electrical");
    if (summary.includes("drywall") || summary.includes("sheetrock")) matched.push("drywall");
    if (summary.includes("paint")) matched.push("paint");
    if (summary.includes("floor")) matched.push("flooring");
    if (summary.includes("hvac") || summary.includes("ac")) matched.push("hvac");
    if (summary.includes("window") || summary.includes("door")) matched.push("windows");
    if (summary.includes("foundation") || summary.includes("settlement")) matched.push("foundation");
    if (summary.includes("siding") || summary.includes("exterior")) matched.push("exterior");

    if (matched.length === 0) {
        matched.push("general");
    }

    return matched;
}

function parseStateFromAddress(addressLine) {
    if (!addressLine) return "";
    const match = addressLine.toUpperCase().match(/\b([A-Z]{2})\b/);

    if (!match) {
        return "";
    }

    return STATE_CODES.has(match[1]) ? match[1] : "";
}

function parseCityFromAddress(addressLine, state) {
    if (!addressLine) return "";

    const parts = addressLine
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

    if (parts.length >= 2) {
        const lastPart = parts[parts.length - 1];
        const tokens = lastPart.split(/\s+/).filter(Boolean);
        const stateIndex = tokens.findIndex(
            (token) => token.toUpperCase() === state
        );

        if (stateIndex >= 0) {
            tokens.splice(stateIndex, tokens.length - stateIndex);
        }

        if (tokens.length > 0) {
            return tokens.join(" ");
        }
    }

    if (state) {
        const match = addressLine.match(new RegExp(`(.+?)\\s+${state}\\b`, "i"));
        if (match && match[1]) {
            return match[1].trim();
        }
    }

    return "";
}
