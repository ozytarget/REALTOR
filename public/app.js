const uploadForm = document.getElementById("uploadForm");
const reportFile = document.getElementById("reportFile");
const uploadStatus = document.getElementById("uploadStatus");
const reportsList = document.getElementById("reportsList");
const dropzone = document.getElementById("dropzone");

const estimateForm = document.getElementById("estimateForm");
const estimateStatus = document.getElementById("estimateStatus");
const estimateResult = document.getElementById("estimateResult");
const reportIdInput = document.getElementById("reportId");

let currentEstimate = null;
let isEditMode = false;
let selectedReportFile = null;
const MAX_UPLOAD_MB = 50;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const currencyFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD"
});

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatSize(bytes) {
    if (!bytes) return "0 KB";
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
}

function normalizeAmount(value) {
    const cleaned = String(value || "").replace(/[^0-9.]/g, "");
    const numberValue = parseFloat(cleaned);
    return Number.isFinite(numberValue) ? numberValue : 0;
}

function formatAmountInput(value) {
    if (value === "" || value === null || typeof value === "undefined") {
        return "";
    }
    return Number(value).toFixed(2);
}

function roundCurrency(value) {
    return Math.round(value * 100) / 100;
}

function calculateTotals(estimate) {
    const taxRate = Number(estimate.taxRate || 0);
    const lineItems = Array.isArray(estimate.lineItems) ? estimate.lineItems : [];
    const subtotalRaw = lineItems.reduce((sum, item) => sum + normalizeAmount(item.total), 0);

    let subtotal = subtotalRaw;
    let tax = subtotal * taxRate;
    let total = subtotal + tax;
    const customTotal = normalizeAmount(estimate.customTotal);

    if (customTotal > 0) {
        total = customTotal;
        subtotal = total / (1 + taxRate);
        tax = total - subtotal;
    }

    return {
        subtotal: roundCurrency(subtotal),
        tax: roundCurrency(tax),
        total: roundCurrency(total)
    };
}

function normalizeEstimate(estimate) {
    const lineItems = Array.isArray(estimate.lineItems) ? estimate.lineItems : [];
    const normalizedLineItems = lineItems.map((item) => {
        const fallbackTotal = Number(item.material || 0) + Number(item.labor || 0);
        return {
            ...item,
            description: item.description || "Line item",
            total: normalizeAmount(item.total || fallbackTotal),
            critical: Boolean(item.critical)
        };
    });

    const criticalItems = normalizedLineItems.filter((item) => item.critical);
    const additionalItems = normalizedLineItems.filter((item) => !item.critical);
    const totals = calculateTotals({ ...estimate, lineItems: normalizedLineItems });

    return {
        ...estimate,
        lineItems: normalizedLineItems,
        criticalItems,
        additionalItems,
        totals
    };
}

function updateDropzoneLabel(file) {
    const title = dropzone.querySelector(".drop-title");
    if (!file) {
        title.textContent = "Drag & drop or click to upload";
        return;
    }

    title.textContent = `Selected: ${file.name}`;
}

async function loadReports() {
    try {
        const response = await fetch("/api/reports");
        if (!response.ok) return;

        const data = await response.json();
        if (!data.reports || data.reports.length === 0) {
            reportsList.innerHTML = "<p class=\"muted\">No reports uploaded yet.</p>";
            return;
        }

        reportsList.innerHTML = data.reports
            .map((report) => {
                const name = escapeHtml(report.name || report.originalName || report.storedName || "Report");
                const reportId = escapeHtml(report.id || report.storedName || report.name);
                const uploaded = escapeHtml(
                    new Date(report.uploadedAt).toLocaleDateString("en-US")
                );
                const size = formatSize(report.size);
                const downloadUrl = report.downloadUrl || report.url || "";

                return `
          <div class="report-item">
            <div>
              <strong>${name}</strong>
              <div class="muted">ID: ${reportId}</div>
              <div class="muted">${uploaded} · ${size}</div>
            </div>
            <div class="report-actions">
                            <button
                type="button"
                class="btn ghost small"
                data-report-id="${reportId}"
                data-report-name="${name}"
              >
                                Use for Estimate
              </button>
                            <a href="${downloadUrl}">Download PDF</a>
            </div>
          </div>
        `;
            })
            .join("");
    } catch (error) {
        reportsList.innerHTML = "<p class=\"muted\">Unable to load reports.</p>";
    }
}

if (uploadForm) {
    uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = (reportFile && reportFile.files && reportFile.files[0]) || selectedReportFile;
    if (!file) {
        uploadStatus.textContent = "Select a PDF file to upload.";
        return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
        uploadStatus.textContent = `File too large. Max ${MAX_UPLOAD_MB}MB.`;
        return;
    }

    uploadStatus.textContent = "Uploading report...";

    const formData = new FormData();
    formData.append("report", file);

    try {
        const response = await fetch("/api/upload", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || "Upload failed.");
        }

        const result = await response.json();
        const report = result.report || {};
        uploadStatus.textContent = `Uploaded ${report.originalName || "report"}. Report ID: ${report.id || ""}.`;
        reportFile.value = "";
        updateDropzoneLabel();
        await loadReports();
    } catch (error) {
        uploadStatus.textContent = error.message || "Upload failed.";
    }
    });
}

if (reportFile) {
    reportFile.addEventListener("change", () => {
        selectedReportFile = reportFile.files[0] || null;
        updateDropzoneLabel(selectedReportFile);
    });
}

if (dropzone) {
    dropzone.addEventListener("click", (event) => {
        if (reportFile && event.target !== reportFile) {
            reportFile.click();
        }
    });

    ["dragenter", "dragover"].forEach((eventName) => {
        dropzone.addEventListener(eventName, (event) => {
            event.preventDefault();
            dropzone.classList.add("dragover");
        });
    });

    ["dragleave", "drop"].forEach((eventName) => {
        dropzone.addEventListener(eventName, (event) => {
            event.preventDefault();
            dropzone.classList.remove("dragover");
        });
    });

    dropzone.addEventListener("drop", (event) => {
        const files = event.dataTransfer ? event.dataTransfer.files : null;
        if (!files || !files.length) return;
        selectedReportFile = files[0];

        if (reportFile && window.DataTransfer) {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(selectedReportFile);
            reportFile.files = dataTransfer.files;
        }

        updateDropzoneLabel(selectedReportFile);
    });
}

if (reportsList) {
    reportsList.addEventListener("click", (event) => {
    const target = event.target.closest("[data-report-id]");
    if (!target) return;

    const reportId = target.getAttribute("data-report-id") || "";
    const reportName = target.getAttribute("data-report-name") || "";
    reportIdInput.value = reportId;
    estimateStatus.textContent = reportName
        ? `Report selected: ${reportName}`
        : "Report selected.";

    document.getElementById("estimate").scrollIntoView({ behavior: "smooth" });
    });
}

if (estimateForm) {
    estimateForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const payload = {
        reportId: document.getElementById("reportId").value.trim()
    };

    estimateStatus.textContent = "Generating estimate...";

    try {
        const response = await fetch("/api/estimate", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || "Unable to generate estimate.");
        }

        const estimate = await response.json();
        renderEstimate(estimate);
        estimateStatus.textContent = "Estimate ready.";
    } catch (error) {
        estimateStatus.textContent = error.message;
    }
    });
}

function renderEstimate(estimate) {
        const baseEstimate = {
                ...estimate,
                customTotal: typeof estimate.customTotal !== "undefined"
                        ? estimate.customTotal
                        : currentEstimate && typeof currentEstimate.customTotal !== "undefined"
                                ? currentEstimate.customTotal
                                : ""
        };
        currentEstimate = normalizeEstimate(baseEstimate);

        const { lineItems, criticalItems, additionalItems, totals, analysis } = currentEstimate;
        const hasSplitItems = criticalItems.length > 0 || additionalItems.length > 0;
        const warnings = Array.isArray(analysis.warnings) ? analysis.warnings : [];
        const location = currentEstimate.location || {};
        const addressLine = location.addressLine && location.addressLine !== "(Address pending)"
                ? location.addressLine
                : "Address pending";
        const cityStateZip = [
                location.city && location.state ? `${location.city}, ${location.state}` : location.city || location.state,
                location.zip
        ]
                .filter(Boolean)
                .join(" ");

        const renderItems = (items, emptyText) => {
                if (!items.length) {
                        return `<p class="muted">${emptyText}</p>`;
                }

                return items
                        .map((item) => {
                                const description = escapeHtml(item.description);
                                const notes = item.notes ? `<div class="muted">${escapeHtml(item.notes)}</div>` : "";
                                const parts = Array.isArray(item.parts) && item.parts.length > 0
                                        ? `<div class="muted">Parts: ${escapeHtml(item.parts.join(", "))}</div>`
                                        : "";
                                return `
                    <div class="line-item">
                        <div>
                            <strong>${description}</strong>
                            <div class="muted">Materials + Labor</div>
                            ${notes}
                            ${parts}
                        </div>
                        <div>${currencyFormatter.format(item.total)}</div>
                    </div>
                `;
                        })
                        .join("");
        };

        const assumptions = (currentEstimate.assumptions || [])
                .map((item) => `<li>${escapeHtml(item)}</li>`)
                .join("");

        const repairsList = Array.isArray(analysis.repairs) && analysis.repairs.length
                ? analysis.repairs
                        .map((repair) => `<li>${escapeHtml(repair.issue || repair.itemKey || "Repair")}</li>`)
                        .join("")
                : "";

        const warningList = warnings.length
                ? warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")
                : "";

        const editRows = lineItems.length
                ? lineItems
                        .map((item, index) => {
                                const description = escapeHtml(item.description);
                                const totalValue = formatAmountInput(item.total);
                                const isCritical = item.critical ? "true" : "false";
                                return `
                    <div class="edit-row" data-edit-index="${index}">
                        <input
                            class="edit-input"
                            data-field="description"
                            type="text"
                            value="${description}"
                            ${isEditMode ? "" : "disabled"}
                        />
                        <input
                            class="edit-input amount"
                            data-field="total"
                            type="text"
                            value="${totalValue}"
                            ${isEditMode ? "" : "disabled"}
                        />
                        <select class="edit-input" data-field="critical" ${isEditMode ? "" : "disabled"}>
                            <option value="true" ${isCritical === "true" ? "selected" : ""}>Critical</option>
                            <option value="false" ${isCritical === "false" ? "selected" : ""}>Additional</option>
                        </select>
                        <button
                            type="button"
                            class="btn ghost small"
                            data-remove-index="${index}"
                            ${isEditMode ? "" : "disabled"}
                        >
                            Remove
                        </button>
                    </div>
                `;
                        })
                        .join("")
                : "<p class=\"muted\">No line items yet.</p>";

        const editButtonLabel = isEditMode ? "Finish Editing" : "Edit Estimate";
        const editBodyStyle = isEditMode ? "" : "style=\"display:none\"";
        const customTotalValue = currentEstimate.customTotal
                ? formatAmountInput(currentEstimate.customTotal)
                : "";
        const customTotalNote = currentEstimate.customTotal
                ? "<p class=\"muted\">Custom total applied.</p>"
                : "<p class=\"muted\">Optional. Overrides the calculated total for PDF output.</p>";

        estimateResult.innerHTML = `
        <div class="output-header">
            <div>
                <h3>Estimate ${escapeHtml(currentEstimate.estimateId)}</h3>
                <p class="muted">${escapeHtml(addressLine)}</p>
                ${cityStateZip ? `<p class=\"muted\">${escapeHtml(cityStateZip)}</p>` : ""}
                <p class="muted">Analysis source: ${escapeHtml(analysis.source || "manual")}</p>
            </div>
            <div>
                <strong>${currencyFormatter.format(totals.total)}</strong>
                <div class="muted">Total</div>
            </div>
        </div>
        <div class="analysis-block">
            <h4>Critical Repairs</h4>
            ${renderItems(criticalItems, "No critical repairs identified.")}
        </div>
        <div class="analysis-block">
            <h4>Additional Repairs</h4>
            ${renderItems(hasSplitItems ? additionalItems : lineItems, "No additional repairs listed.")}
        </div>
        <div class="analysis-block">
            <h4>AI Findings</h4>
            <p class="muted">${escapeHtml(analysis.summary || "No report analysis available.")}</p>
            ${repairsList ? `<ul class=\"analysis-list\">${repairsList}</ul>` : ""}
            ${warningList ? `<ul class=\"analysis-warnings\">${warningList}</ul>` : ""}
        </div>
        <div class="analysis-block">
            <div class="edit-header">
                <h4>Estimate Adjustments</h4>
                <button type="button" class="btn ghost small" id="toggleEditEstimate">${editButtonLabel}</button>
            </div>
            <div class="edit-body" ${editBodyStyle}>
                <div class="edit-grid">
                    ${editRows}
                </div>
                <button type="button" class="btn ghost small" id="addLineItem">Add Line Item</button>
                <div class="edit-field">
                    <label for="customTotal">Custom Total (optional)</label>
                    <input
                        id="customTotal"
                        class="edit-input amount"
                        data-field="customTotal"
                        type="text"
                        value="${customTotalValue}"
                        ${isEditMode ? "" : "disabled"}
                    />
                    ${customTotalNote}
                </div>
            </div>
        </div>
        <div class="total-row">
            <span>Subtotal</span>
            <span>${currencyFormatter.format(totals.subtotal)}</span>
        </div>
        <div class="total-row">
            <span>Tax (${(currentEstimate.taxRate * 100).toFixed(1)}%)</span>
            <span>${currencyFormatter.format(totals.tax)}</span>
        </div>
        <div class="total-row">
            <span>Grand Total</span>
            <span>${currencyFormatter.format(totals.total)}</span>
        </div>
        <div class="analysis-block">
            <h4>Assumptions</h4>
            <ul>${assumptions}</ul>
        </div>
        <div class="output-actions">
            <button class="btn ghost" id="downloadPdf">Download Estimate PDF</button>
        </div>
    `;

        estimateResult.classList.toggle("is-editing", isEditMode);

    const downloadButton = document.getElementById("downloadPdf");
    if (downloadButton) {
        downloadButton.addEventListener("click", () => downloadEstimatePdf(currentEstimate));
    }
}

async function downloadEstimatePdf(estimate) {
    if (!estimate) return;
    const payload = normalizeEstimate(estimate);
    estimateStatus.textContent = "Preparing PDF...";

    try {
        const response = await fetch("/api/estimate/pdf", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || "Unable to generate PDF.");
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `estimate-${estimate.estimateId}.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
        estimateStatus.textContent = "PDF downloaded.";
    } catch (error) {
        estimateStatus.textContent = error.message;
    }
}

function handleEstimateClick(event) {
    const toggleButton = event.target.closest("#toggleEditEstimate");
    if (toggleButton) {
        isEditMode = !isEditMode;
        renderEstimate(currentEstimate || {});
        return;
    }

    const addButton = event.target.closest("#addLineItem");
    if (addButton) {
        if (!currentEstimate) return;
        currentEstimate.lineItems = Array.isArray(currentEstimate.lineItems)
            ? currentEstimate.lineItems
            : [];
        currentEstimate.lineItems.push({
            description: "Custom line item",
            total: 0,
            critical: false
        });
        renderEstimate(currentEstimate);
        return;
    }

    const removeButton = event.target.closest("[data-remove-index]");
    if (removeButton && currentEstimate && Array.isArray(currentEstimate.lineItems)) {
        const index = Number(removeButton.getAttribute("data-remove-index"));
        if (!Number.isNaN(index)) {
            currentEstimate.lineItems.splice(index, 1);
            renderEstimate(currentEstimate);
        }
    }
}

function handleEstimateChange(event) {
    if (!currentEstimate) return;
    const target = event.target;

    if (target.id === "customTotal") {
        currentEstimate.customTotal = target.value.trim();
        renderEstimate(currentEstimate);
        return;
    }

    const row = target.closest("[data-edit-index]");
    if (!row) return;

    const index = Number(row.getAttribute("data-edit-index"));
    const field = target.getAttribute("data-field");
    if (Number.isNaN(index) || !field || !currentEstimate.lineItems) return;

    const item = currentEstimate.lineItems[index];
    if (!item) return;

    if (field === "description") {
        item.description = target.value.trim();
    }
    if (field === "total") {
        item.total = normalizeAmount(target.value);
    }
    if (field === "critical") {
        item.critical = target.value === "true";
    }

    renderEstimate(currentEstimate);
}

if (estimateResult) {
    estimateResult.addEventListener("click", handleEstimateClick);
    estimateResult.addEventListener("change", handleEstimateChange);
}

document.querySelectorAll("[data-reveal]").forEach((element, index) => {
    setTimeout(() => {
        element.classList.add("is-visible");
    }, 120 + index * 140);
});

updateDropzoneLabel();
loadReports();

let sessionCleanupSent = false;

function sendSessionCleanup() {
    if (sessionCleanupSent) return;
    sessionCleanupSent = true;

    if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/session/cleanup");
        return;
    }

    fetch("/api/session/cleanup", {
        method: "POST",
        keepalive: true
    }).catch(() => {});
}

window.addEventListener("pagehide", sendSessionCleanup);
window.addEventListener("beforeunload", sendSessionCleanup);
