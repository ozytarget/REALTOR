require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const PDFDocument = require("pdfkit");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 3000;
const TAX_RATE = 0.078;

const uploadsDir = path.join(__dirname, "uploads");
const REPORT_INDEX_PATH = path.join(uploadsDir, "report-index.json");
const PRICING_PATH = path.join(__dirname, "data", "pricing.json");
const LOGO_PATH = path.join(__dirname, "public", "assets", "a-pro-handyman-llc.jpeg");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const geminiClient = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
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

const storage = multer.diskStorage({
    destination: uploadsDir,
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
        fileSize: 10 * 1024 * 1024
    }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/upload", upload.single("report"), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded." });
    }

    const reportEntry = storeReportIndexEntry(req.file);

    return res.json({
        ok: true,
        report: reportEntry
    });
});

app.get("/api/reports", (req, res) => {
    try {
        const index = loadReportIndex();
        const reports = index
            .map((entry) => {
                const filePath = path.join(uploadsDir, entry.storedName);
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
                    url: `/api/reports/${encodeURIComponent(entry.storedName)}`
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

    const filePath = path.join(uploadsDir, safeName);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found." });
    }

    return res.download(filePath);
});

app.post("/api/estimate", async (req, res) => {
    try {
        const payload = req.body || {};
        const estimate = await buildEstimate(payload);
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

async function buildEstimate(payload) {
    const location = resolveLocation(payload);
    const regionProfile = getRegionProfile(location.state);
    const reportEntry = payload.reportId ? findReportEntry(payload.reportId) : null;
    const hasAnalysisInput = Boolean(payload.summary || reportEntry);
    const analysis = hasAnalysisInput
        ? await analyzeInspection({ reportEntry, summary: payload.summary, location })
        : buildEmptyAnalysis();

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
        assumptions.push("AI extraction used to map inspector report to repair items.");
    } else if (analysis.source === "heuristic" && analysis.reportId) {
        assumptions.push("Rule-based extraction used for the inspector report.");
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

function buildEmptyAnalysis() {
    return {
        source: "manual",
        summary: "",
        criticalSummary: "",
        repairs: [],
        warnings: [],
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

async function analyzeInspection({ reportEntry, summary, location }) {
    const analysis = buildEmptyAnalysis();
    const warnings = [];
    let pdfBuffer = null;
    let pdfText = "";

    if (reportEntry) {
        const filePath = path.join(uploadsDir, reportEntry.storedName);
        if (fs.existsSync(filePath)) {
            pdfBuffer = fs.readFileSync(filePath);
            pdfText = await extractPdfText(pdfBuffer);
        }
    }

    const combinedText = [summary, pdfText].filter(Boolean).join("\n").trim();
    let result = extractFindingsFromText(combinedText);
    let source = "heuristic";

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
            "Schema: { summary: string, criticalSummary: string, repairs: [{ itemKey, issue, action, critical, parts }] }",
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
        repairs: dedupeRepairs(repairs)
    };
}

function loadReportIndex() {
    try {
        if (!fs.existsSync(REPORT_INDEX_PATH)) {
            const files = fs
                .readdirSync(uploadsDir)
                .filter((name) => name.toLowerCase().endsWith(".pdf"));

            if (files.length === 0) {
                return [];
            }

            const index = files.map((name) => {
                const stats = fs.statSync(path.join(uploadsDir, name));
                return {
                    id: createReportId(),
                    storedName: name,
                    originalName: name,
                    uploadedAt: stats.mtime.toISOString()
                };
            });

            saveReportIndex(index);
            return index;
        }
        const raw = fs.readFileSync(REPORT_INDEX_PATH, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function saveReportIndex(index) {
    fs.writeFileSync(REPORT_INDEX_PATH, JSON.stringify(index, null, 2));
}

function createReportId() {
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `REP-${Date.now()}-${suffix}`;
}

function storeReportIndexEntry(file) {
    const index = loadReportIndex();
    const entry = {
        id: createReportId(),
        storedName: file.filename,
        originalName: file.originalname,
        uploadedAt: new Date().toISOString()
    };

    index.unshift(entry);
    saveReportIndex(index);
    return entry;
}

function findReportEntry(reportId) {
    if (!reportId) return null;
    const normalized = reportId.trim().toLowerCase();
    const index = loadReportIndex();

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
    let headerBottom = headerTop;

    if (fs.existsSync(LOGO_PATH)) {
        const logoWidth = 140;
        const logoHeight = 90;
        doc.image(LOGO_PATH, doc.page.margins.left, headerTop, {
            fit: [logoWidth, logoHeight]
        });
        headerBottom = Math.max(headerBottom, headerTop + logoHeight);
    }

    doc.fontSize(20).text("Estimate", 0, headerTop, { align: "right" });
    doc.fontSize(10).text(`Estimate ID: ${estimate.estimateId}`, { align: "right" });
    headerBottom = Math.max(headerBottom, doc.y);
    doc.y = headerBottom + 10;

    doc.fontSize(12).text(estimate.company || "A PRO HANDYMAN LLC");
    if (estimate.contractor) {
        doc.fontSize(10).text(`Contractor: ${estimate.contractor}`);
    }
    if (estimate.location && estimate.location.addressLine) {
        doc.fontSize(10).text(`Property: ${estimate.location.addressLine}`);
    }
    doc.fontSize(10).text(
        `Location: ${estimate.location.city || ""}, ${estimate.location.state || ""} ${estimate.location.zip || ""}`
    );
    doc.moveDown();

    renderPdfSection(doc, "Critical Repairs", estimate.criticalItems || []);
    renderPdfSection(doc, "Additional Repairs", estimate.additionalItems || []);

    doc.moveDown();
    doc.fontSize(12).text("Totals");
    doc.fontSize(10).text(`Subtotal: ${formatCurrency(estimate.totals.subtotal)}`);
    doc.fontSize(10).text(`Tax (${(estimate.taxRate * 100).toFixed(1)}%): ${formatCurrency(estimate.totals.tax)}`);
    doc.fontSize(11).text(`Grand Total: ${formatCurrency(estimate.totals.total)}`);

    if (estimate.analysis && estimate.analysis.summary) {
        doc.moveDown();
        doc.fontSize(11).text("AI Findings");
        doc.fontSize(9).text(estimate.analysis.summary);
    }

    doc.end();
}

function renderPdfSection(doc, title, items) {
    doc.fontSize(12).text(title, { underline: true });

    if (!items.length) {
        doc.fontSize(9).text("None listed.");
        doc.moveDown(0.5);
        return;
    }

    items.forEach((item) => {
        doc.fontSize(10).text(item.description, { continued: true });
        doc.fontSize(10).text(formatCurrency(item.total), { align: "right" });
        if (item.notes) {
            doc.fontSize(8).text(item.notes);
        }
        if (Array.isArray(item.parts) && item.parts.length > 0) {
            doc.fontSize(8).text(`Parts: ${item.parts.join(", ")}`);
        }
        doc.moveDown(0.3);
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
    const city = inputCity || parseCityFromAddress(addressLine, state) || "Duluth";

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
