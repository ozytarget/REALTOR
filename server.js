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
const LOGO_PATH = path.join(__dirname, "public", "assets", "logo.png");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-insecure-secret-change";
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
        const rawValue = valueParts.join("=") || "";
        try {
            acc[key] = decodeURIComponent(rawValue);
        } catch (error) {
            acc[key] = rawValue;
        }
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

function signSessionId(sessionId) {
    return crypto
        .createHmac("sha256", SESSION_SECRET)
        .update(String(sessionId || ""))
        .digest("hex")
        .slice(0, 24);
}

function parseSignedSession(value) {
    const raw = String(value || "");
    const dotIndex = raw.lastIndexOf(".");
    if (dotIndex <= 0) {
        return "";
    }

    const rawId = raw.slice(0, dotIndex);
    const signature = raw.slice(dotIndex + 1);
    const sessionId = sanitizeSessionId(rawId);
    if (!sessionId || !signature) {
        return "";
    }

    const expected = signSessionId(sessionId);
    const actualBuffer = Buffer.from(signature, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    if (actualBuffer.length !== expectedBuffer.length) {
        return "";
    }

    if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
        return "";
    }

    return sessionId;
}

function ensureSession(req, res) {
    const cookies = parseCookies(req.headers.cookie || "");
    let sessionId = parseSignedSession(cookies.realtor_session);

    if (!sessionId || sessionId.length < 20) {
        sessionId = createSessionId();
        const signedSession = `${sessionId}.${signSessionId(sessionId)}`;

        const cookieParts = [
            `realtor_session=${encodeURIComponent(signedSession)}`,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            "Max-Age=86400"
        ];

        if (process.env.NODE_ENV === "production") {
            cookieParts.push("Secure");
        }

        res.setHeader(
            "Set-Cookie",
            cookieParts.join("; ")
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

    let fd = null;
    try {
        const uploadedPath = req.file.path;
        fd = fs.openSync(uploadedPath, "r");
        const headerBuffer = Buffer.alloc(5);
        fs.readSync(fd, headerBuffer, 0, 5, 0);
        if (headerBuffer.toString("utf8") !== "%PDF-") {
            fs.unlinkSync(uploadedPath);
            return res.status(400).json({ error: "Uploaded file is not a valid PDF." });
        }
    } catch (error) {
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        return res.status(400).json({ error: "Unable to validate uploaded PDF." });
    } finally {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch (error) {
                // No-op: validation already completed or file descriptor is closed.
            }
        }
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

app.delete("/api/reports/:id", (req, res) => {
    try {
        const reportId = String(req.params.id || "").trim();
        const entry = findReportEntry(req.sessionDir, reportId);

        if (!entry) {
            return res.status(404).json({ error: "Report not found." });
        }

        const index = loadReportIndex(req.sessionDir);
        const updatedIndex = index.filter((item) => item.id !== entry.id);
        saveReportIndex(req.sessionDir, updatedIndex);

        const filePath = path.join(req.sessionDir, entry.storedName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        return res.json({ ok: true });
    } catch (error) {
        return res.status(500).json({ error: "Unable to delete report." });
    }
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

    const clearCookieParts = [
        "realtor_session=",
        "Path=/",
        "Max-Age=0",
        "HttpOnly",
        "SameSite=Lax"
    ];
    if (process.env.NODE_ENV === "production") {
        clearCookieParts.push("Secure");
    }

    res.setHeader("Set-Cookie", clearCookieParts.join("; "));
    return res.json({ ok: true });
});

app.post("/api/estimate", async (req, res) => {
    try {
        const payload = req.body || {};
        const estimate = await buildEstimate(payload, req.sessionDir);
        res.json(estimate);
    } catch (error) {
        const message = error.message || "Unable to generate estimate.";
        if (message === "Report ID not found.") {
            return res.status(404).json({ error: message });
        }
        res.status(500).json({ error: message });
    }
});

app.post("/api/estimate/pdf", (req, res) => {
    try {
        const estimate = req.body;
        if (!estimate || !estimate.estimateId || !Array.isArray(estimate.lineItems)) {
            return res.status(400).json({ error: "Estimate payload is required." });
        }

        const subtotal = estimate.lineItems.reduce((sum, item) => {
            const value = Number(item && item.total);
            return sum + (Number.isFinite(value) ? value : 0);
        }, 0);
        const taxRate = Number(estimate.taxRate || TAX_RATE);
        const roundedSubtotal = Math.round(subtotal * 100) / 100;
        const tax = Math.round(roundedSubtotal * taxRate * 100) / 100;
        const total = Math.round((roundedSubtotal + tax) * 100) / 100;

        const safeEstimate = {
            ...estimate,
            taxRate,
            totals: {
                subtotal: roundedSubtotal,
                tax,
                total
            }
        };

        return generateEstimatePdf(safeEstimate, res);
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
    if (payload.reportId && !requestedReport) {
        throw new Error("Report ID not found.");
    }
    const fallbackReport = !payload.reportId && !payload.summary
        ? getLatestReportEntry(sessionDir)
        : null;
    const reportEntry = requestedReport || fallbackReport;
    const hasAnalysisInput = Boolean(payload.summary || reportEntry);
    const analysis = hasAnalysisInput
        ? await analyzeInspection({ reportEntry, summary: payload.summary, location: baseLocation, sessionDir })
        : buildEmptyAnalysis();
    const location = mergeLocations(baseLocation, analysis.location);
    const regionProfile = getRegionProfile(location.state);

    let lineItems;
    if (analysis.repairs.length > 0) {
        lineItems = buildLineItemsFromRepairs(analysis.repairs, regionProfile);
        console.log(`[ESTIMATE] Using ${lineItems.length} repair-based line items`);
    } else {
        const fallbackSummary = payload.summary || analysis._pdfText || analysis.summary || "";
        const areas = resolveAreas({ ...payload, summary: fallbackSummary });
        lineItems = buildLineItemsFromAreas(areas, regionProfile);
        console.log(`[ESTIMATE] Fallback to area-based: [${areas.join(", ")}]`);
    }

    const criticalItems = lineItems.filter((item) => item.critical);
    const additionalItems = lineItems.filter((item) => !item.critical);
    const subtotal = Math.round(lineItems.reduce((sum, item) => sum + item.total, 0) * 100) / 100;
    const tax = Math.round(subtotal * TAX_RATE * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;

    const assumptions = [
        "Pricing is based on project scope, labor, and contractor costs.",
        "Final scope and pricing confirmed after onsite review.",
        "Any additional work requires written approval."
    ];

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
    const itemsCatalog = PRICING.items || DEFAULT_PRICING.items;
    const areaToItemKey = {
        roof: "roof_leak",
        plumbing: "plumbing_leak",
        electrical: "electrical_hazard",
        hvac: "hvac_service",
        foundation: "foundation_crack",
        windows: "windows_doors",
        exterior: "exterior_repair",
        flooring: "flooring_repair",
        drywall: "drywall_repair",
        general: "general_repair"
    };

    return areas.map((area) => {
        const catalogEntry = REPAIR_CATALOG[area] || REPAIR_CATALOG.general;
        const mappedItemKey = areaToItemKey[area] || "general_repair";
        const pricingEntry = itemsCatalog[mappedItemKey];
        const materialBase = pricingEntry
            ? Number(pricingEntry.material || 0)
            : Number(catalogEntry.material || DEFAULT_PRICING.items.general_repair.material);
        const laborBase = pricingEntry
            ? Number(pricingEntry.labor || 0)
            : Number(catalogEntry.labor || DEFAULT_PRICING.items.general_repair.labor);
        const material = Math.round(materialBase * materialMultiplier);
        const labor = Math.round(laborBase * laborMultiplier);

        return {
            area,
            description: pricingEntry && pricingEntry.label ? pricingEntry.label : catalogEntry.label,
            material,
            labor,
            total: material + labor,
            critical: Boolean(pricingEntry && pricingEntry.critical)
        };
    });
}

function buildLineItemsFromRepairs(repairs, regionProfile) {
    const materialMultiplier = regionProfile.materialMultiplier || 1;
    const laborMultiplier = regionProfile.laborMultiplier || 1;
    const itemsCatalog = PRICING.items || DEFAULT_PRICING.items;
    const areaMapByItemKey = {
        water_heater_replace: "plumbing",
        water_heater_repair: "plumbing",
        roof_leak: "roof",
        plumbing_leak: "plumbing",
        electrical_hazard: "electrical",
        hvac_service: "hvac",
        foundation_crack: "foundation",
        windows_doors: "windows",
        exterior_repair: "exterior",
        flooring_repair: "flooring",
        drywall_repair: "drywall",
        appliance_repair: "general",
        garage_repair: "exterior",
        insulation_repair: "exterior"
    };
    const grouped = new Map();

    repairs.forEach((repair) => {
        const itemKey = normalizeRepairKey(repair);
        const current = grouped.get(itemKey) || { ...repair, itemKey, quantity: 0 };
        current.quantity += 1;
        if (!current.notes && repair.notes) {
            current.notes = repair.notes;
        }
        if (!current.parts && Array.isArray(repair.parts)) {
            current.parts = repair.parts;
        }
        current.critical = Boolean(current.critical || repair.critical);
        grouped.set(itemKey, current);
    });

    return Array.from(grouped.values()).map((repair) => {
        const pricingItem = itemsCatalog[repair.itemKey];
        const fallbackArea = areaMapByItemKey[repair.itemKey] || "general";
        const catalogFallback = REPAIR_CATALOG[fallbackArea] || REPAIR_CATALOG.general;
        const materialBase = pricingItem
            ? Number(pricingItem.material || 0)
            : Number(catalogFallback.material || DEFAULT_PRICING.items.general_repair.material);
        const laborBase = pricingItem
            ? Number(pricingItem.labor || 0)
            : Number(catalogFallback.labor || DEFAULT_PRICING.items.general_repair.labor);
        const notes = repair.notes || (pricingItem && pricingItem.notes) || "";
        const parts = Array.isArray(repair.parts)
            ? repair.parts
            : Array.isArray(pricingItem && pricingItem.parts)
                ? pricingItem.parts
                : [];

        const quantity = Math.max(1, Number(repair.quantity || 1));
        const material = Math.round(materialBase * materialMultiplier * quantity);
        const labor = Math.round(laborBase * laborMultiplier * quantity);

        return {
            area: repair.itemKey,
            description: pricingItem && pricingItem.label ? pricingItem.label : (catalogFallback.label || "General Repairs"),
            quantity,
            material,
            labor,
            total: material + labor,
            critical: Boolean(repair.critical || (pricingItem && pricingItem.critical)),
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
    if (system.includes("window") || system.includes("door")) return "windows_doors";
    if (system.includes("exterior") || system.includes("siding") || system.includes("gutter")) return "exterior_repair";
    if (system.includes("floor")) return "flooring_repair";
    if (system.includes("drywall") || system.includes("sheetrock") || system.includes("wall")) return "drywall_repair";
    if (system.includes("appliance") || system.includes("dishwasher") || system.includes("oven") || system.includes("range")) return "appliance_repair";
    if (system.includes("garage")) return "garage_repair";
    if (system.includes("insulation") || system.includes("attic") || system.includes("crawl")) return "insulation_repair";

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
            const extraction = await extractPdfText(pdfBuffer);
            pdfText = extraction.text;
            if (extraction.error) {
                warnings.push(extraction.error);
            }
            console.log(`[PDF] Extracted ${pdfText.length} chars from ${reportEntry.originalName}`);
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
        if (aiResult.warning) {
            warnings.push(aiResult.warning);
        }
        if (aiResult.data && aiResult.data.repairs.length > 0) {
            const extracted = aiResult.data;
            if (!extracted.location && result.location) {
                extracted.location = result.location;
            }
            result = extracted;
            source = "gemini";
            console.log(`[GEMINI] Found ${result.repairs.length} repairs`);
        }
    } else if (pdfBuffer && pdfText.trim().length < 40) {
        warnings.push("PDF appears scanned. Configure GEMINI_API_KEY to enable OCR.");
    }

    console.log(`[ANALYSIS] source=${source}, repairs=${result.repairs.length}, text=${pdfText.length} chars`);

    return {
        ...analysis,
        ...result,
        source,
        warnings,
        reportId: reportEntry ? reportEntry.id : "",
        reportName: reportEntry ? reportEntry.originalName : "",
        _pdfText: combinedText
    };
}

async function extractPdfText(buffer) {
    try {
        const data = await pdfParse(buffer);
        return {
            text: String(data.text || "").trim(),
            error: ""
        };
    } catch (error) {
        return {
            text: "",
            error: "PDF text extraction failed."
        };
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

    const lines = String(text || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const positiveLineRegex = /(satisfactory|serviceable|ok|acceptable|monitor|maintain|good condition|no defects|no issues|no problems|no repairs?|no action|none observed)/i;
    const negatedIssueRegex = /(no|none|without)\s+(leak|leaks|damage|damaged|defect|defects|problem|problems|issue|issues|hazard|hazards|unsafe|crack|cracks|corrosion|rust|burst|failure|repair|replace)/i;
    const excludedLineRegex = /(inspected|recommended maintenance|typical life|service life|information only|for your information|appears serviceable|working as intended|maintenance item)/i;
    const issueOnlyRegex = /(leak|leaking|damage|damaged|defect|defective|unsafe|hazard|crack|corrosion|rust|failure|not working|not cooling|not heating|active seepage|missing|exposed|overheat|burst|improper)/i;
    const candidateWindows = lines
        .map((line, index) => {
            const nextLine = lines[index + 1] || "";
            return [line, nextLine].filter(Boolean).join(" ");
        })
        .filter((windowText) => {
            return !positiveLineRegex.test(windowText)
                && !negatedIssueRegex.test(windowText)
                && !excludedLineRegex.test(windowText)
                && issueOnlyRegex.test(windowText);
        });

    const lineHasIssue = (line, systemRegex, issueRegex) => {
        if (!systemRegex.test(line) || !issueRegex.test(line)) {
            return false;
        }

        if (positiveLineRegex.test(line) || negatedIssueRegex.test(line) || excludedLineRegex.test(line)) {
            return false;
        }

        return true;
    };

    const hasIssueForSystem = (systemRegex, issueRegex) => {
        if (!systemRegex || !issueRegex) {
            return false;
        }

        const matchLine = candidateWindows.some((windowText) => lineHasIssue(windowText, systemRegex, issueRegex));
        if (matchLine) {
            return true;
        }
        return false;
    };

    const waterHeaterRegex = /water\s*heater|waterheater/i;
    const waterHeaterIssueRegex = /(leak|leaking|corrosion|rust|failed|not working|defect|damage|improper|missing pan|exposed)/i;
    if (hasIssueForSystem(waterHeaterRegex, waterHeaterIssueRegex)) {
        const waterHeaterContext = candidateWindows.filter((line) => waterHeaterRegex.test(line)).join(" ").toLowerCase();
        const shouldReplace = /(replace|replacement|leak|corrosion|rust|failed|not working)/i.test(waterHeaterContext);
        const canRepair = /(service needed|improper|defect|damage)/i.test(waterHeaterContext);
        const action = shouldReplace || !canRepair ? "replace" : "repair";

        repairs.push({
            itemKey: action === "replace" ? "water_heater_replace" : "water_heater_repair",
            system: "water heater",
            action,
            issue: "Water heater requires attention.",
            critical: action === "replace" || /leak|leaking/.test(waterHeaterContext)
        });

        summaryParts.push("Water heater issue detected.");
        if (action === "replace") {
            criticalParts.push("Water heater replacement recommended.");
        }
    }

    const roofRegex = /roof/i;
    const roofIssueRegex = /(leak|leaking|damage|damaged|missing|defect|deterior|active seepage|exposed)/i;
    if (hasIssueForSystem(roofRegex, roofIssueRegex)) {
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

    const plumbingRegex = /plumb|pipe|water line|supply line|drain/i;
    const plumbingIssueRegex = /(leak|leaking|burst|corrosion|rust|damage|damaged|defect|clog|backup|active seepage|improper)/i;
    if (hasIssueForSystem(plumbingRegex, plumbingIssueRegex)) {
        const plumbingContext = candidateWindows.filter((line) => plumbingRegex.test(line)).join(" ").toLowerCase();
        repairs.push({
            itemKey: "plumbing_leak",
            system: "plumbing",
            action: "repair",
            issue: "Plumbing leak reported.",
            critical: /leak|burst|active seepage/.test(plumbingContext)
        });
        summaryParts.push("Plumbing issue detected.");
    }

    const electricalRegex = /electrical|panel|wiring|outlet|breaker/i;
    const electricalIssueRegex = /(hazard|unsafe|overheat|exposed|defect|arc|burn|shock|improper)/i;
    if (hasIssueForSystem(electricalRegex, electricalIssueRegex)) {
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

    const hvacRegex = /hvac|air condition|ac unit|furnace|heat pump/i;
    const hvacIssueRegex = /(not working|not cooling|not heating|failure|leak|defect|improper|damaged)/i;
    if (hasIssueForSystem(hvacRegex, hvacIssueRegex)) {
        repairs.push({
            itemKey: "hvac_service",
            system: "hvac",
            action: "service",
            issue: "HVAC service noted.",
            critical: false
        });
        summaryParts.push("HVAC issue detected.");
    }

    const foundationRegex = /foundation|settlement|crack/i;
    const foundationIssueRegex = /(crack|settlement|movement|defect|damage|damaged|active seepage|unsafe)/i;
    if (hasIssueForSystem(foundationRegex, foundationIssueRegex)) {
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

    const windowsRegex = /window|door|sliding|patio door|storm door/i;
    const windowsIssueRegex = /(broken|crack|seal|fog|damage|damaged|rot|replace|repair|recommend|draft|leak|deteriorat)/i;
    if (hasIssueForSystem(windowsRegex, windowsIssueRegex)) {
        repairs.push({
            itemKey: "windows_doors",
            system: "windows/doors",
            action: "repair",
            issue: "Window or door issue detected.",
            critical: false
        });
        summaryParts.push("Window/door issue detected.");
    }

    const exteriorRegex = /exterior|siding|fascia|soffit|gutter|downspout|trim|stucco|brick/i;
    const exteriorIssueRegex = /(damage|damaged|rot|deteriorat|missing|loose|crack|repair|replace|recommend|leak|peel)/i;
    if (hasIssueForSystem(exteriorRegex, exteriorIssueRegex)) {
        repairs.push({
            itemKey: "exterior_repair",
            system: "exterior",
            action: "repair",
            issue: "Exterior damage reported.",
            critical: false
        });
        summaryParts.push("Exterior issue detected.");
    }

    const flooringRegex = /floor|carpet|tile|vinyl|laminate|hardwood/i;
    const flooringIssueRegex = /(damage|damaged|crack|loose|buckl|stain|worn|repair|replace|recommend|water|warp)/i;
    if (hasIssueForSystem(flooringRegex, flooringIssueRegex)) {
        repairs.push({
            itemKey: "flooring_repair",
            system: "flooring",
            action: "repair",
            issue: "Flooring issue detected.",
            critical: false
        });
        summaryParts.push("Flooring issue detected.");
    }

    const drywallRegex = /drywall|sheetrock|wall|ceiling|interior wall|interior surface/i;
    const drywallIssueRegex = /(crack|hole|damage|damaged|water stain|stain|patch|repair|replace|recommend|peel|bubble|nail pop)/i;
    if (hasIssueForSystem(drywallRegex, drywallIssueRegex)) {
        repairs.push({
            itemKey: "drywall_repair",
            system: "drywall",
            action: "repair",
            issue: "Drywall or interior surface damage.",
            critical: false
        });
        summaryParts.push("Drywall issue detected.");
    }

    const applianceRegex = /appliance|dishwasher|oven|range|stove|microwave|disposal|garbage disposal|refrigerator/i;
    const applianceIssueRegex = /(not working|broken|leak|damage|damaged|defect|repair|replace|recommend|malfunction|inoperable)/i;
    if (hasIssueForSystem(applianceRegex, applianceIssueRegex)) {
        repairs.push({
            itemKey: "appliance_repair",
            system: "appliances",
            action: "repair",
            issue: "Appliance issue detected.",
            critical: false
        });
        summaryParts.push("Appliance issue detected.");
    }

    const garageRegex = /garage|garage door|opener/i;
    const garageIssueRegex = /(not working|broken|damage|damaged|defect|repair|replace|recommend|malfunction|inoperable|safety|reverse)/i;
    if (hasIssueForSystem(garageRegex, garageIssueRegex)) {
        repairs.push({
            itemKey: "garage_repair",
            system: "garage",
            action: "repair",
            issue: "Garage door issue detected.",
            critical: false
        });
        summaryParts.push("Garage door issue detected.");
    }

    const insulationRegex = /insulation|attic|crawl\s*space|vapor barrier/i;
    const insulationIssueRegex = /(missing|insufficient|damage|damaged|wet|mold|moisture|repair|replace|recommend|inadequate)/i;
    if (hasIssueForSystem(insulationRegex, insulationIssueRegex)) {
        repairs.push({
            itemKey: "insulation_repair",
            system: "insulation",
            action: "repair",
            issue: "Insulation issue detected.",
            critical: false
        });
        summaryParts.push("Insulation issue detected.");
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
        return { data: null, warning: "" };
    }

    try {
        const model = geminiClient.getGenerativeModel({ model: GEMINI_MODEL });
        const prompt = [
            "You are a repair estimator.",
            "Read the inspector report and return ONLY JSON.",
            "Schema: { summary: string, criticalSummary: string, location: { addressLine, city, state, zip }, repairs: [{ itemKey, issue, action, critical, parts }] }",
            "If the property address is present, fill location fields. Otherwise use empty strings.",
            "Allowed itemKey values: water_heater_replace, water_heater_repair, roof_leak, plumbing_leak, electrical_hazard, hvac_service, foundation_crack, windows_doors, exterior_repair, flooring_repair, drywall_repair, appliance_repair, garage_repair, insulation_repair, general_repair.",
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
        return {
            data: normalizeGeminiResult(parsed),
            warning: ""
        };
    } catch (error) {
        return {
            data: null,
            warning: "Gemini analysis failed; using heuristic parser."
        };
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
        index.find((entry) => entry.originalName.toLowerCase() === normalized) ||
        null
    );
}

function ensurePdfSpace(doc, neededHeight) {
    const spaceNeeded = Number(neededHeight || 60);
    const bottomLimit = doc.page.height - doc.page.margins.bottom;
    if (doc.y + spaceNeeded > bottomLimit) {
        doc.addPage();
    }
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
    const reportLabel = estimate.reportId ? `Report ID: ${estimate.reportId}` : "Report ID: Not provided";
    const reportNameLabel = estimate.reportName ? `Report: ${estimate.reportName}` : "Report: Not provided";
    const propertyTypeLabel = `Property Type: ${estimate.propertyType || "Single Family"}`;

    const contentX = centeredLeft;
    doc.fontSize(11).text("Property Details", contentX, doc.y, { width: contentWidth });
    doc.fontSize(10).text(propertyAddress, contentX, doc.y, { width: contentWidth });
    if (cityStateZip) {
        doc.fontSize(10).text(cityStateZip, contentX, doc.y, { width: contentWidth });
    }
    doc.fontSize(10).text(propertyTypeLabel, contentX, doc.y, { width: contentWidth });
    doc.fontSize(10).text(reportLabel, contentX, doc.y, { width: contentWidth });
    doc.fontSize(10).text(reportNameLabel, contentX, doc.y, { width: contentWidth });
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

    if (Array.isArray(estimate.assumptions) && estimate.assumptions.length > 0) {
        doc.moveDown();
        doc.fontSize(11).text("Assumptions", contentX, doc.y, { width: contentWidth });
        doc.fontSize(9);
        estimate.assumptions.forEach((line) => {
            doc.text(`- ${line}`, contentX, doc.y, { width: contentWidth });
        });
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

    ensurePdfSpace(doc, 40);
    doc.fontSize(12).text(title, contentX, doc.y, { underline: true, width: contentWidth });

    if (!items.length) {
        ensurePdfSpace(doc, 24);
        doc.fontSize(9).text("None listed.", contentX, doc.y, { width: contentWidth });
        doc.moveDown(0.5);
        return;
    }

    items.forEach((item) => {
        ensurePdfSpace(doc, 56);
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
    if (summary.includes("plumb") || summary.includes("pipe") || summary.includes("drain")) matched.push("plumbing");
    if (summary.includes("elect") || summary.includes("wiring") || summary.includes("panel") || summary.includes("outlet")) matched.push("electrical");
    if (summary.includes("drywall") || summary.includes("sheetrock") || summary.includes("nail pop") || summary.includes("wall crack")) matched.push("drywall");
    if (summary.includes("paint") || summary.includes("peel")) matched.push("paint");
    if (summary.includes("floor") || summary.includes("carpet") || summary.includes("tile") || summary.includes("vinyl")) matched.push("flooring");
    if (summary.includes("hvac") || summary.includes("ac ") || summary.includes("air condition") || summary.includes("furnace") || summary.includes("heat pump")) matched.push("hvac");
    if (summary.includes("window") || summary.includes("door")) matched.push("windows");
    if (summary.includes("foundation") || summary.includes("settlement")) matched.push("foundation");
    if (summary.includes("siding") || summary.includes("exterior") || summary.includes("gutter") || summary.includes("fascia") || summary.includes("soffit")) matched.push("exterior");
    if (summary.includes("water heater") || summary.includes("waterheater")) matched.push("plumbing");
    if (summary.includes("garage") || summary.includes("opener")) matched.push("exterior");
    if (summary.includes("insulation") || summary.includes("attic") || summary.includes("crawl")) matched.push("exterior");
    if (summary.includes("appliance") || summary.includes("dishwasher") || summary.includes("disposal") || summary.includes("oven") || summary.includes("range")) matched.push("general");

    if (matched.length === 0) {
        matched.push("general");
    }

    return [...new Set(matched)];
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
