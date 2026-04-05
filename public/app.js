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

uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = reportFile.files[0];
    if (!file) {
        uploadStatus.textContent = "Select a PDF file to upload.";
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
        uploadStatus.textContent = error.message;
    }
});

reportFile.addEventListener("change", () => {
    updateDropzoneLabel(reportFile.files[0]);
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

estimateForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const payload = {
        addressLine: document.getElementById("addressLine").value.trim(),
        city: document.getElementById("city").value.trim(),
        state: document.getElementById("state").value.trim(),
        zip: document.getElementById("zip").value.trim(),
        propertyType: document.getElementById("propertyType").value,
        reportId: document.getElementById("reportId").value.trim(),
        summary: document.getElementById("summary").value.trim(),
        repairAreas: Array.from(
            document.querySelectorAll("input[name=\"repairAreas\"]:checked")
        ).map((checkbox) => checkbox.value)
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

function renderEstimate(estimate) {
    currentEstimate = estimate;
    const allItems = Array.isArray(estimate.lineItems) ? estimate.lineItems : [];
    const criticalItems = Array.isArray(estimate.criticalItems)
        ? estimate.criticalItems
        : [];
    const additionalItems = Array.isArray(estimate.additionalItems)
        ? estimate.additionalItems
        : [];
    const hasSplitItems = criticalItems.length > 0 || additionalItems.length > 0;
    const analysis = estimate.analysis || {};
    const warnings = Array.isArray(analysis.warnings) ? analysis.warnings : [];

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

    const assumptions = (estimate.assumptions || [])
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

    estimateResult.innerHTML = `
    <div class="output-header">
      <div>
        <h3>Estimate ${escapeHtml(estimate.estimateId)}</h3>
        <p class="muted">${escapeHtml(estimate.location.city)}, ${escapeHtml(
        estimate.location.state
    )}</p>
        <p class="muted">Analysis source: ${escapeHtml(analysis.source || "manual")}</p>
      </div>
      <div>
        <strong>${currencyFormatter.format(estimate.totals.total)}</strong>
        <div class="muted">Total</div>
      </div>
    </div>
    <div class="analysis-block">
      <h4>Critical Repairs</h4>
      ${renderItems(criticalItems, "No critical repairs identified.")}
    </div>
    <div class="analysis-block">
      <h4>Additional Repairs</h4>
      ${renderItems(hasSplitItems ? additionalItems : allItems, "No additional repairs listed.")}
    </div>
    <div class="analysis-block">
      <h4>AI Findings</h4>
      <p class="muted">${escapeHtml(analysis.summary || "No report analysis available.")}</p>
      ${repairsList ? `<ul class="analysis-list">${repairsList}</ul>` : ""}
      ${warningList ? `<ul class="analysis-warnings">${warningList}</ul>` : ""}
    </div>
    <div class="total-row">
      <span>Subtotal</span>
      <span>${currencyFormatter.format(estimate.totals.subtotal)}</span>
    </div>
    <div class="total-row">
      <span>Tax (${(estimate.taxRate * 100).toFixed(1)}%)</span>
      <span>${currencyFormatter.format(estimate.totals.tax)}</span>
    </div>
    <div class="total-row">
      <span>Grand Total</span>
      <span>${currencyFormatter.format(estimate.totals.total)}</span>
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
        downloadButton.addEventListener("click", () => downloadEstimatePdf(estimate));
    }
}

async function downloadEstimatePdf(estimate) {
    if (!estimate) return;
    estimateStatus.textContent = "Preparing PDF...";

    try {
        const response = await fetch("/api/estimate/pdf", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(estimate)
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

document.querySelectorAll("[data-reveal]").forEach((element, index) => {
    setTimeout(() => {
        element.classList.add("is-visible");
    }, 120 + index * 140);
});

updateDropzoneLabel();
loadReports();
