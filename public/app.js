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
let selectedReportFile = null;
const MAX_UPLOAD_MB = 50;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
let suspendCleanup = false;

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

function normalizeLineItems(items, prefix, source) {
    const lineItems = Array.isArray(items) ? items : [];
    const safePrefix = prefix || "estimate";
    const safeSource = source || "ai";
    return lineItems.map((item, index) => {
        const fallbackTotal = Number(item.material || 0) + Number(item.labor || 0);
        return {
            ...item,
            rowId: item.rowId || `${safePrefix}-${index}`,
            description: item.description || "Line item",
            total: normalizeAmount(item.total || fallbackTotal),
            material: Number.isFinite(Number(item.material)) ? Number(item.material) : 0,
            labor: Number.isFinite(Number(item.labor)) ? Number(item.labor) : 0,
            critical: Boolean(item.critical),
            source: item.source || safeSource
        };
    });
}

function sumLineItems(items) {
    return items.reduce((sum, item) => sum + normalizeAmount(item.total), 0);
}

function applyExclusions(items, excludedIds) {
    if (!excludedIds || !excludedIds.length) {
        return items;
    }
    const excludedSet = new Set(excludedIds);
    return items.filter((item) => !excludedSet.has(item.rowId));
}

function scaleLineItems(items, scale, targetSubtotal) {
    if (!items.length) return [];

    const scaledItems = items.map((item) => {
        const material = item.material ? roundCurrency(item.material * scale) : 0;
        const labor = item.labor ? roundCurrency(item.labor * scale) : 0;
        const total = roundCurrency(item.total * scale);

        return {
            ...item,
            material,
            labor,
            total
        };
    });

    const subtotal = sumLineItems(scaledItems);
    const diff = roundCurrency(targetSubtotal - subtotal);
    if (scaledItems.length && Math.abs(diff) > 0) {
        const lastIndex = scaledItems.length - 1;
        scaledItems[lastIndex].total = roundCurrency(scaledItems[lastIndex].total + diff);
    }

    return scaledItems;
}

function calculateTotals(estimate) {
    const taxRate = Number(estimate.taxRate || 0);
    const lineItems = Array.isArray(estimate.lineItems) ? estimate.lineItems : [];
    const subtotalRaw = sumLineItems(lineItems);
    const subtotal = roundCurrency(subtotalRaw);
    const tax = roundCurrency(subtotal * taxRate);
    const total = roundCurrency(subtotal + tax);

    return { subtotal, tax, total };
}

function normalizeEstimate(estimate) {
    const aiLineItems = normalizeLineItems(
        estimate.baseLineItems || estimate.lineItems || [],
        estimate.estimateId,
        "ai"
    );
    const customItems = normalizeLineItems(
        estimate.customItems || [],
        `${estimate.estimateId}-custom`,
        "custom"
    ).map((item) => ({
        ...item,
        critical: false
    }));
    const baseLineItems = [...aiLineItems, ...customItems];
    const excludedRowIds = Array.isArray(estimate.excludedRowIds)
        ? estimate.excludedRowIds
        : [];
    const includedLineItems = applyExclusions(baseLineItems, excludedRowIds);
    const customTotal = normalizeAmount(estimate.customTotal);
    const taxRate = Number(estimate.taxRate || 0);
    let adjustedLineItems = includedLineItems;

    if (customTotal > 0) {
        const targetSubtotal = roundCurrency(customTotal / (1 + taxRate));
        const baseSubtotal = sumLineItems(includedLineItems);
        const scale = baseSubtotal > 0 ? targetSubtotal / baseSubtotal : 1;
        adjustedLineItems = scaleLineItems(includedLineItems, scale, targetSubtotal);
    }

    const criticalItems = adjustedLineItems.filter((item) => item.critical);
    const additionalItems = adjustedLineItems.filter((item) => !item.critical);
    const totals = customTotal > 0
        ? {
            subtotal: roundCurrency(customTotal / (1 + taxRate)),
            tax: roundCurrency(customTotal - customTotal / (1 + taxRate)),
            total: roundCurrency(customTotal)
        }
        : calculateTotals({ ...estimate, lineItems: adjustedLineItems });

    return {
        ...estimate,
        baseLineItems,
        customItems,
        excludedRowIds,
        lineItems: adjustedLineItems,
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
                                                        <button
                                                                type="button"
                                                                class="btn ghost small"
                                                                data-download-url="${downloadUrl}"
                                                                data-download-name="${name}"
                                                        >
                                                                Download PDF
                                                        </button>
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
    const downloadButton = event.target.closest("[data-download-url]");
    if (downloadButton) {
        const url = downloadButton.getAttribute("data-download-url") || "";
        const name = downloadButton.getAttribute("data-download-name") || "report.pdf";
        downloadReport(url, name);
        return;
    }

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
    const estimateIdChanged =
        !currentEstimate || currentEstimate.estimateId !== estimate.estimateId;
    const baseLineItems = estimateIdChanged
        ? estimate.lineItems
        : currentEstimate && currentEstimate.baseLineItems
            ? currentEstimate.baseLineItems
            : estimate.lineItems;
    const excludedRowIds = estimateIdChanged
        ? []
        : currentEstimate && Array.isArray(currentEstimate.excludedRowIds)
            ? currentEstimate.excludedRowIds
            : [];
    const customItems = estimateIdChanged
        ? []
        : currentEstimate && Array.isArray(currentEstimate.customItems)
            ? currentEstimate.customItems
            : [];

    const baseEstimate = {
        ...estimate,
        baseLineItems,
        excludedRowIds,
        customItems,
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

        const customTotalValue = currentEstimate.customTotal
                ? formatAmountInput(currentEstimate.customTotal)
                : "";
        const customTotalNote = currentEstimate.customTotal
            ? "<p class=\"muted\">Custom total applied. Line items adjusted proportionally.</p>"
            : "<p class=\"muted\">Optional. Adjusts the total and scales line items.</p>";
        const serviceRows = currentEstimate.baseLineItems && currentEstimate.baseLineItems.length
                ? currentEstimate.baseLineItems
                .map((item) => {
                    const rowId = item.rowId;
                    const isExcluded = currentEstimate.excludedRowIds.includes(rowId);
                    const label = isExcluded ? "Restore" : "Remove";
                    const status = isExcluded ? "Excluded" : "Included";
                    const rowClass = isExcluded ? "service-row is-excluded" : "service-row";
                                const sourceLabel = item.source === "custom" ? "Custom" : "AI";
                    return `
                <div class="${rowClass}">
                <div>
                    <strong>${escapeHtml(item.description)}</strong>
                            <div class="muted">${sourceLabel} · ${status}</div>
                </div>
                <button
                    type="button"
                    class="btn ghost small"
                    data-toggle-row-id="${rowId}"
                >
                    ${label}
                </button>
                </div>
            `;
                })
                .join("")
            : "<p class=\"muted\">No services found.</p>";

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
            <h4>Total Adjustment</h4>
            <div class="edit-field">
                <label>Services</label>
                <div class="service-list">
                    ${serviceRows}
                </div>
                <p class="muted">Remove a service to exclude it from totals and the PDF.</p>
            </div>
            <div class="edit-field">
                <label>Add Service</label>
                <div class="add-row">
                    <input
                        id="customItemDescription"
                        class="edit-input"
                        type="text"
                        placeholder="Service description"
                    />
                    <input
                        id="customItemAmount"
                        class="edit-input amount"
                        type="text"
                        placeholder="0.00"
                    />
                    <button type="button" class="btn ghost small" id="addCustomItem">Add</button>
                </div>
            </div>
            <div class="edit-field">
                <label for="customTotal">Custom Total (optional)</label>
                <input
                    id="customTotal"
                    class="edit-input amount"
                    data-field="customTotal"
                    type="text"
                    value="${customTotalValue}"
                />
                ${customTotalNote}
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

    const downloadButton = document.getElementById("downloadPdf");
    if (downloadButton) {
        downloadButton.addEventListener("click", () => downloadEstimatePdf(currentEstimate));
    }
}

async function downloadEstimatePdf(estimate) {
    if (!estimate) return;
    const payload = normalizeEstimate(estimate);
    estimateStatus.textContent = "Preparing PDF...";
    suspendCleanup = true;

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
    } finally {
        setTimeout(() => {
            suspendCleanup = false;
        }, 1500);
    }
}

async function downloadReport(url, name) {
    if (!url) return;
    uploadStatus.textContent = "Preparing download...";
    suspendCleanup = true;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || "Unable to download report.");
        }

        const blob = await response.blob();
        const fileName = name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
        const downloadUrl = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(downloadUrl);
        uploadStatus.textContent = "Report downloaded.";
    } catch (error) {
        uploadStatus.textContent = error.message || "Download failed.";
    } finally {
        setTimeout(() => {
            suspendCleanup = false;
        }, 1500);
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
}

function handleEstimateClick(event) {
    if (!currentEstimate) return;
    const addButton = event.target.closest("#addCustomItem");
    if (addButton) {
        const descriptionInput = document.getElementById("customItemDescription");
        const amountInput = document.getElementById("customItemAmount");
        const description = descriptionInput ? descriptionInput.value.trim() : "";
        const amount = amountInput ? normalizeAmount(amountInput.value) : 0;

        if (!description) {
            estimateStatus.textContent = "Enter a service description.";
            return;
        }

        if (!Number.isFinite(amount) || amount <= 0) {
            estimateStatus.textContent = "Enter a valid amount for the service.";
            return;
        }

        const customItems = Array.isArray(currentEstimate.customItems)
            ? currentEstimate.customItems
            : [];
        customItems.push({
            description,
            total: amount,
            critical: false,
            source: "custom",
            rowId: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        });
        currentEstimate.customItems = customItems;

        if (descriptionInput) descriptionInput.value = "";
        if (amountInput) amountInput.value = "";
        estimateStatus.textContent = "Custom service added.";
        renderEstimate(currentEstimate);
        return;
    }

    const toggleButton = event.target.closest("[data-toggle-row-id]");
    if (!toggleButton) return;

    const rowId = toggleButton.getAttribute("data-toggle-row-id");
    if (!rowId) return;

    const excluded = new Set(currentEstimate.excludedRowIds || []);
    if (excluded.has(rowId)) {
        excluded.delete(rowId);
    } else {
        excluded.add(rowId);
    }

    currentEstimate.excludedRowIds = Array.from(excluded);
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
    if (sessionCleanupSent || suspendCleanup) return;
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
