const API_BASE_URL = "https://shopeeyt.onrender.com";
let pollInterval = null;
let jobWatchdog = null; // Cầu chì bảo vệ toàn cục

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.isAutoTagging) {
    console.log("Auto-tagging state changed to:", changes.isAutoTagging.newValue);
    if (changes.isAutoTagging.newValue) {
      startPolling();
    } else {
      stopPolling();
    }
  }
});

// Start if it was already running on reload or if it's the first time
chrome.storage.local.get(['isAutoTagging'], (result) => {
  if (result.isAutoTagging !== false) { // Default to true
    startPolling();
  }
});

function startPolling() {
  if (pollInterval) return;
  if (jobWatchdog) clearTimeout(jobWatchdog); // Dọn dẹp cầu chì cũ
  console.log("Started polling API every 3 seconds...");
  pollInterval = setInterval(pollAPI, 500);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log("Stopped polling API.");
  }
}

function startWatchdog(jobId) {
  if (jobWatchdog) clearTimeout(jobWatchdog);
  // Hạn giờ toàn cục cho 1 lệnh (40 giây)
  jobWatchdog = setTimeout(() => {
    console.warn("WATCHDOG: Lệnh quá lâu. Đang tự động báo lỗi...");
    reportError(jobId, "Có lỗi xảy ra, vui lòng gắn lại mã.").then(() => {
      startPolling();
    });
  }, 40000); 
}

async function pollAPI() {
  try {
    const res = await fetch(`${API_BASE_URL}/get-pending-link`);
    const data = await res.json();
    
    if (data.has_link && data.job_id && data.shopee_url) {
      console.log("Found new job:", data.job_id, data.shopee_url);
      stopPolling();
      
      const tabs = await chrome.tabs.query({ url: ["*://studio.youtube.com/*", "*://www.youtube.com/*"] });
      
      const studioTab = tabs.find(t => t.url.includes("studio.youtube.com"));
      const pwaTab = tabs.find(t => t.url.includes("www.youtube.com/live") || t.url.includes("www.youtube.com/watch"));
      
      if (!studioTab) {
        console.warn("No Studio tab found!");
        await reportError(data.job_id, "Không tìm thấy tab YouTube Studio (để gắn thẻ).");
        startPolling();
        return;
      }

      console.log("Distributing tasks: Studio Tab:", studioTab.id, "PWA Tab:", pwaTab ? pwaTab.id : "NONE");
      
      // BẮT ĐẦU HẸN GIỜ CẦU CHÌ (WATCHDOG)
      startWatchdog(data.job_id);

      // Xóa ID cũ để tránh gửi nhầm
      chrome.storage.local.remove(['currentPwaTabId', 'currentJobId'], () => {
        // Ghi nhớ PWA tab MỚI (nếu có)
        if (pwaTab) {
          chrome.storage.local.set({ 
            currentPwaTabId: pwaTab.id,
            currentJobId: data.job_id 
          });
        }
      });

      // GỬI LỆNH CHO STUDIO TRƯỚC (Cơ chế kiên nhẫn)
      const success = await sendMessageWithRetry(studioTab.id, {
        action: "START_TAGGING",
        jobId: data.job_id,
        shopeeUrl: data.shopee_url
      });

      if (!success) {
        console.error("Failed to connect to Studio tab.");
        await reportError(data.job_id, "Không thể kết nối với tab YouTube Studio.");
        startPolling();
      }
    }
  } catch (err) {
    console.error("Error polling API:", err);
    startPolling();
  }
}

async function reportError(jobId, errorMsg) {
    if (!jobId) return;
    console.log("Reporting error for job:", jobId, errorMsg);
    return fetch(`${API_BASE_URL}/submit-youtube-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, yt_link: `ERROR:${errorMsg}` })
    });
}

async function sendMessageWithRetry(tabId, message, maxRetries = 8) {
    // THỬ PHÁT ĐẦU LUÔN - TỐI QUAN TRỌNG ĐỂ KHÔNG CÓ ĐỘ TRỄ
    try {
        await chrome.tabs.sendMessage(tabId, message);
        console.log(`Sent action ${message.action} immediately to tab ${tabId}`);
        return true;
    } catch (e) {
        console.log(`Phát đầu action ${message.action} xịt, chuyển sang Ping & Retry...`);
    }

    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await new Promise((resolve, reject) => {
                chrome.tabs.sendMessage(tabId, { action: "PING" }, (resp) => {
                    if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                    else resolve(resp);
                });
            });
            if (response && response.status === "OK") {
                chrome.tabs.sendMessage(tabId, message);
                return true;
            }
        } catch (e) {
            if (i === 1) { // Lần 3 xịt (i=1 vì đã thử 1 phát đầu + 1 phát ping)
                console.log("Force injecting content script because tab is silent:", tabId);
                try {
                    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
                } catch (err) { console.error("Force injection failed:", err); }
            }
            await new Promise(r => setTimeout(r, 400)); // Đợi siêu ngắn 0.4s
        }
    }
    return false;
}

// Giao tiếp với Content Script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "STUDIO_TAGGING_FINISHED") {
    console.log("Studio says TAGGING FINISHED. Now triggering PWA extraction...");
    chrome.storage.local.get(['currentPwaTabId', 'currentJobId'], async (res) => {
      if (res.currentPwaTabId) {
        // CHUYỂN TAB LẬP TỨC CHO NGƯỜI DÙNG THẤY
        chrome.tabs.update(res.currentPwaTabId, { active: true });
        
        const success = await sendMessageWithRetry(res.currentPwaTabId, {
          action: "START_EXTRACTION",
          jobId: res.currentJobId
        });
        if (!success) {
            console.error("Failed to trigger PWA extraction.");
            reportError(res.currentJobId, "Không thể kết nối với PWA để lấy link.").then(() => startPolling());
        }
      } else {
        console.warn("Tagging done but NO PWA tab found.");
        reportError(res.currentJobId, "Gắn thẻ xong nhưng không tìm thấy tab PWA để lấy link.").then(() => startPolling());
      }
    });

  } else if (message.action === "TAGGING_COMPLETE") {
    console.log("EXTRACTION complete for job:", message.jobId, "Link:", message.youtubeLink);
    fetch(`${API_BASE_URL}/submit-youtube-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: message.jobId, yt_link: message.youtubeLink })
    }).then(() => {
      console.log("Successfully reported completion. Returning to Studio for reset...");
      
      // QUAY LẠI STUDIO ĐỂ XOÁ CŨ
      chrome.tabs.query({ url: "*://studio.youtube.com/*" }, async (tabs) => {
        if (tabs.length > 0) {
          const studioTab = tabs[0];
          chrome.tabs.update(studioTab.id, { active: true });
          await sendMessageWithRetry(studioTab.id, { action: "RESET_STUDIO_UI" });
        } else {
          // Nếu không thấy Studio thì thôi, cứ poll tiếp
          startPolling();
        }
      });
    }).catch(err => {
      console.error("Failed to report completion:", err);
      startPolling();
    });

  } else if (message.action === "STUDIO_RESET_DONE") {
    console.log("Studio UI Reset Complete. Now starting next job queue...");
    startPolling();

  } else if (message.action === "TAGGING_ERROR") {
    console.error("Tagging error:", message.jobId, message.error);
    reportError(message.jobId, message.error).then(() => startPolling());
  }
});
