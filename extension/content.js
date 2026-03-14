if (window.hasShopeeTaggerLoaded) {
    console.log("Shopee Tagger is already loaded in this tab. Skipping double injection.");
} else {
    window.hasShopeeTaggerLoaded = true;

console.log("=========================================");
console.log("YouTube Shopee Tagger v6.4 (Turbo) LOADED");
console.log("Target:", window.location.href);
console.log("=========================================");

// --- HỆ THỐNG THÔNG BÁO UI (TOAST) ---
function showToast(message, type = 'info') {
    let oldToast = document.getElementById('shopee-tagger-toast');
    if (oldToast) oldToast.remove();

    const toast = document.createElement('div');
    toast.id = 'shopee-tagger-toast';
    toast.style.cssText = `
        position: fixed; top: 20px; right: 20px; padding: 15px 20px;
        border-radius: 8px; color: white; font-weight: bold;
        z-index: 9999999; font-size: 14px; box-shadow: 0 4px 6px rgba(0,0,0,0.3);
        transition: all 0.3s ease; pointer-events: none;
    `;

    if (type === 'error') {
        toast.style.backgroundColor = '#f44336';
        toast.innerText = '❌ ' + message;
    } else if (type === 'success') {
        toast.style.backgroundColor = '#4CAF50';
        toast.innerText = '✅ ' + message;
    } else {
        toast.style.backgroundColor = '#2196F3';
        toast.innerText = 'ℹ️ ' + message;
    }

    document.documentElement.appendChild(toast);

    const duration = type === 'error' ? 10000 : 4000;
    setTimeout(() => {
        if (toast && toast.parentNode) {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }
    }, duration);
}

function sleep(ms) {
    return new window.Promise(resolve => setTimeout(resolve, ms));
}

// --- SIÊU RADAR XUYÊN SHADOW DOM 4.0 ---
// Hàm này quét mọi ngóc ngách, bới tung mọi Shadow Root
function findDeep(selector, root = document) {
    let results = [];
    
    // 1. Tìm ở root hiện tại
    try {
        const found = (root.querySelectorAll) ? root.querySelectorAll(selector) : [];
        results = results.concat(Array.from(found));
    } catch (e) {}

    // 2. Đi sâu vào các Shadow Root của toàn bộ tẻ con
    const all = (root.querySelectorAll) ? root.querySelectorAll('*') : [];
    for (const el of all) {
        if (el.shadowRoot) {
            results = results.concat(findDeep(selector, el.shadowRoot));
        }
    }
    
    // Loại bỏ trùng lặp
    return [...new Set(results)];
}

// Hàm khoanh vùng mục tiêu để người dùng thấy
function highlightElement(el) {
    if (!el) return;
    const originalOutline = el.style.outline;
    el.style.outline = '3px solid red';
    el.style.outlineOffset = '-3px';
    setTimeout(() => {
        if (el) el.style.outline = originalOutline;
    }, 2000);
}

function nuclearClick(el) {
    if (!el) return;
    try {
        highlightElement(el);
        el.scrollIntoView({ block: 'center' });
        
        // Giả lập chuỗi sự kiện đầy đủ
        const eventOptions = { bubbles: true, cancelable: true, view: window, composed: true };
        el.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
        el.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        el.focus();
        el.dispatchEvent(new PointerEvent('pointerup', eventOptions));
        el.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        el.click();
        
        console.log("Nuclear click performed on:", el);
    } catch (e) {
        console.error("Click failed", e);
    }
}

function simulatePaste(inputElement, text) {
    inputElement.focus();
    inputElement.value = text;
    inputElement.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    inputElement.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

// 0. Kiểm tra xem tab này có phải là tab đang thực hiện Job không (Dùng sessionStorage để lock)
chrome.storage.local.get(['pendingExtractionJobId'], (result) => {
    const isThisTabJobInstance = sessionStorage.getItem('isShopeeTaggerJobInstance') === 'true';
    const isStudio = window.location.href.includes("studio.youtube.com");
    
    if (isStudio) {
        // ĐẢM BẢO TAB STUDIO KHÔNG BAO GIỜ CÓ FLAG NÀY
        sessionStorage.removeItem('isShopeeTaggerJobInstance');
        return;
    }

    if (result.pendingExtractionJobId && isThisTabJobInstance) {
        console.log("Tab này là PWA đang thực hiện Job. Bắt đầu trích xuất...");
        finishExtraction(result.pendingExtractionJobId);
    } else if (result.pendingExtractionJobId) {
        console.log("Phát hiện Job đang chạy ở tab khác. Tab này (Studio/Tab lẻ) sẽ không can thiệp.");
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "PING") {
        sendResponse({ status: "OK" });
        return;
    }
    if (message.action === "START_TAGGING") {
        console.log("Tab này nhận lệnh GẮN THẺ (Studio Mode)");
        startTagging(message.jobId, message.shopeeUrl);
    }
    if (message.action === "RESET_STUDIO_UI") {
        console.log("Tiến hành Reset Studio: Bấm Sửa -> Bấm Xoá...");
        (async () => {
            try {
                // 1. Bấm nút SỬA (Mở bảng chọn)
                const editBtn = document.querySelector("#selection-panel-product-picker-button > ytcp-button-shape > button > yt-touch-feedback-shape > div.yt-spec-touch-feedback-shape__fill");
                if (editBtn) {
                    nuclearClick(editBtn.closest('button') || editBtn);
                    showToast("Đang mở bảng sản phẩm...", 'info');
                    
                    // 2. Đợi nút XOÁ xuất hiện (Tối đa 3s)
                    const resetStartTime = Date.now();
                    while (Date.now() - resetStartTime < 3000) {
                        const clearBtn = document.querySelector("#selected-product-clear-all > ytcp-button-shape > button > yt-touch-feedback-shape > div.yt-spec-touch-feedback-shape__fill");
                        if (clearBtn && clearBtn.getBoundingClientRect().width > 0) {
                            nuclearClick(clearBtn.closest('button') || clearBtn);
                            showToast("ĐÃ XOÁ CŨ! Sẵn sàng cho link mới...", 'success');
                            break; 
                        }
                        await sleep(200);
                    }
                }
            } catch (e) {
                console.error("Lỗi khi reset UI:", e);
            } finally {
                // BÁO CHO BACKGROUND LÀ ĐÃ XOÁ XONG, SẴN SÀNG NHẬN JOB MỚI
                chrome.runtime.sendMessage({ action: "STUDIO_RESET_DONE" });
            }
        })();
    }
    if (message.action === "START_EXTRACTION") {
        // NGĂN CHẶN TUYỆT ĐỐI việc reload trên tab Studio
        if (window.location.href.includes("studio.youtube.com")) {
            console.warn("Nhận lệnh extraction trên Studio. Bỏ qua để tránh reload.");
            return;
        }
        console.log("Tab này nhận lệnh TRÍCH XUẤT (PWA Mode). Đang chuẩn bị Refresh...");
        // Đánh dấu tab này là tab "Chính chủ" thực hiện Extraction
        sessionStorage.setItem('isShopeeTaggerJobInstance', 'true');
        chrome.storage.local.set({ pendingExtractionJobId: message.jobId }, () => {
            location.reload();
        });
    }
});

async function startTagging(jobId, shopeeUrl) {
    try {
        showToast("Bắt đầu quy trình gắn thẻ...", 'info');
        
        // 1. Tìm ô nhập link (Dựa trên ID và ARIA Label bạn vừa gửi)
        let searchInput = findDeep('#search-input, [aria-label*="Tìm sản phẩm"], [placeholder*="Tìm sản phẩm"]')[0];
        
        if (!searchInput) {
            // Dự phòng: Quét qua tất cả input nếu không tìm thấy bằng selector
            const inputs = findDeep('input');
            for (const input of inputs) {
                const ph = (input.placeholder || '').toLowerCase();
                const al = (input.getAttribute('aria-label') || '').toLowerCase();
                if (ph.includes("liên kết") || ph.includes("tìm sản phẩm") || al.includes("tìm sản phẩm")) {
                    searchInput = input;
                    break;
                }
            }
        }

        if (searchInput) highlightElement(searchInput);

        if (!searchInput) {
            showToast("KHÔNG THẤY Ô NHẬP LINK. Hãy chắc chắn bạn đã mở bảng 'Gắn thẻ sản phẩm'.", 'error');
            throw new Error("No input");
        }

        // 2. Dán link và Enter
        showToast("Đang dán link và giả lập Enter...", 'info');
        simulatePaste(searchInput, shopeeUrl);
        await sleep(800); 
        
        ['keydown', 'keypress', 'keyup'].forEach(type => {
            searchInput.dispatchEvent(new KeyboardEvent(type, { 
                key: "Enter", code: "Enter", keyCode: 13, which: 13, 
                bubbles: true, composed: true, cancelable: true 
            }));
        });

        // 3. QUY TRÌNH CHỜ ĐIỀU KIỆN (Polling) - Chỉ bấm khi thấy nút
        showToast("Đang tìm sản phẩm...", 'info');
        let added = false;
        const maxWaitTime = 10000; // Đợi tối đa 10 giây (Theo yêu cầu Bản 8.7)
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWaitTime) {
            await sleep(500); 
            
            // Tìm nút [+] dựa trên JS Path chính xác bạn vừa gửi
            let candidates = [];
            
            // Chiến thuật: "Nội bất xuất, ngoại bất nhập" - Chỉ tìm trong đúng khung Gắn thẻ 
            const resultsPanel = findDeep('ytshopping-product-picker-search-results-panel');
            
            if (resultsPanel.length > 0) {
                // Chỉ tìm các hàng kết quả thực sự (Search Result)
                const searchResults = findDeep('ytshopping-product-picker-search-result', resultsPanel[0]);
                
                for (let result of searchResults) {
                    const btn = findDeep('ytcp-icon-button.tag-product-button, #add-button', result)[0];
                    if (btn) {
                        candidates.push(btn);
                    } else {
                        const paths = findDeep('path', result);
                        for (let p of paths) {
                            if (p.getAttribute('d') === 'M12 3a1 1 0 00-1 1v7H4a1 1 0 000 2h7v7a1 1 0 002 0v-7h7a1 1 0 000-2h-7V4a1 1 0 00-1-1Z') {
                                const b = p.closest('button, ytcp-icon-button, [role="button"]');
                                if (b) candidates.push(b);
                            }
                        }
                    }
                }
            }

            // Kiểm tra và bấm nút thực sự
            for (const btn of candidates) {
                const rect = btn.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    const label = (btn.getAttribute('aria-label') || btn.title || 'Nút Gắn Thẻ').toLowerCase();
                    if (label.includes('tải lên') || label.includes('tạo')) continue;

                    showToast(`BẮT TRÚNG MỤC TIÊU!`, 'success');
                    highlightElement(btn); 
                    nuclearClick(btn);
                    added = true;
                    break;
                }
            }

            if (added) break;

            const elapsed = Math.round((Date.now() - startTime) / 1000);
            if (elapsed % 2 === 0) {
                showToast(`Đang tìm nút [+]... (${elapsed}s/10s)`, 'info');
            }
        }

        if (!added) {
            const errorMsg = "Shop bạn gửi không hỗ trợ mã, tìm sản phẩm này trên shop khác và gắn lại.";
            showToast(errorMsg, 'error');
            
            chrome.runtime.sendMessage({ 
                action: "TAGGING_ERROR", 
                jobId: jobId, 
                error: errorMsg 
            });
            
            throw new Error(errorMsg);
        }

        // 4. Bấm nút HOÀN TẤT (XONG/LƯU trong Modal)
        showToast("Đang tìm nút HOÀN TẤT trong bảng...", 'info');
        let modalDoneClicked = false;
        const modalStartTime = Date.now();
        
        while (Date.now() - modalStartTime < 5000) {
            const feedbacks = findDeep('.yt-spec-touch-feedback-shape__fill');
            for (let f of feedbacks) {
                const btn = f.closest('button, ytcp-button, [role="button"]');
                if (btn) {
                    const txt = (btn.innerText || btn.textContent || '').toLowerCase();
                    const rect = btn.getBoundingClientRect();
                    const isModalDone = (txt.includes('xong') || txt.includes('lưu') || txt.includes('done') || txt.includes('save')) && rect.width > 0;
                    
                    if (isModalDone) {
                        showToast(`Đã bấm nút hoàn tất trong bảng!`, 'success');
                        nuclearClick(btn);
                        modalDoneClicked = true;
                        break;
                    }
                }
            }
            if (modalDoneClicked) break;
            await sleep(100); // Quét nhanh hơn (10 lần/s)
        }

        // 4.5 Bấm nút LƯU TỔNG (Trang chính - Nếu có)
        // LOẠI BỎ sleep(1500) cố định để đạt tốc độ MAXIMUM
        let finalSaveClicked = false;
        const finalStartTime = Date.now();
        while (Date.now() - finalStartTime < 4000) {
            const feedbacks = findDeep('.yt-spec-touch-feedback-shape__fill');
            for (let f of feedbacks) {
                const btn = f.closest('button, ytcp-button, [role="button"]');
                if (btn) {
                    const txt = (btn.innerText || btn.textContent || '').toLowerCase();
                    const rect = btn.getBoundingClientRect();
                    // Nút Lưu tổng thường ở góc trên bên phải, sáng màu (not disabled)
                    if (rect.width > 0 && (txt.includes('lưu') || txt.includes('save')) && !btn.disabled) {
                        showToast(`CHỐT HẠ: Đã bấm LƯU TỔNG!`, 'success');
                        nuclearClick(btn);
                        finalSaveClicked = true;
                        break;
                    }
                }
            }
            if (finalSaveClicked) break;
            await sleep(100); // Quét cực nhanh
        }

        // GỬI LỆNH CHUYỂN TAB NGAY LẬP TỨC
        showToast("XONG! Đang chuyển qua App...", 'success');
        chrome.runtime.sendMessage({ action: "STUDIO_TAGGING_FINISHED", jobId: jobId });
        // STUDIO TAB KẾT THÚC TẠI ĐÂY - KHÔNG ĐƯỢC RELOAD
    } catch (err) {
        console.error("Lỗi tại Studio:", err);
        chrome.runtime.sendMessage({ action: "TAGGING_ERROR", jobId: jobId, error: err.message });
    }
}

async function finishExtraction(jobId) {
    try {
        let retryCount = parseInt(sessionStorage.getItem('shopeeTaggerRetryCount') || '0', 10);
        console.log(`Radar 6.0 (Sniper) - Lượt ${retryCount + 1} cho Job: ${jobId}`);
        
        let linkFound = false;
        const searchStartTime = Date.now();
        const searchDuration = 2000; 
        const linkRegex = /s\.shopee\.vn|shopee\.vn|affiliate_id|an_redir|sub_id/i;

        while (Date.now() - searchStartTime < searchDuration) {
            // Sniper 7.0: "F12 DEEP SCAN" - Quét cả mã nguồn Script
            let detectedUrl = null;

            // BƯỚC 1: QUÉT SCRIPT TAGS (Dữ liệu ngầm YouTube - "F12 Mode")
            const scriptTags = document.getElementsByTagName('script');
            for (const script of scriptTags) {
                const text = script.textContent || "";
                if (text.length > 50 && linkRegex.test(text)) {
                    // Trích xuất link thô từ chuỗi JSON/Code
                    const match = text.match(/https?:\/\/[^"'\s<>]+(?:s\.shopee\.vn|shopee\.vn|an_redir|affiliate_id|sub_id)[^"'\s<>]*/i);
                    if (match) {
                        detectedUrl = match[0].replace(/\\u0026/g, '&').replace(/\\/g, ''); // Giải mã JSON string
                        console.log("F12 DEEP SCAN - Tìm thấy trong Script:", detectedUrl);
                        break;
                    }
                }
            }

            // BƯỚC 2: QUÉT DOM (Nếu bước 1 chưa thấy)
            if (!detectedUrl) {
                const elements = findDeep('*');
                for (const el of elements) {
                    if (el.href && linkRegex.test(el.href)) {
                        detectedUrl = el.href;
                        break;
                    }
                    if (el.attributes) {
                        for (let i = 0; i < el.attributes.length; i++) {
                            const attr = el.attributes[i];
                            if (linkRegex.test(attr.value) && attr.value.startsWith('http')) {
                                detectedUrl = attr.value;
                                break;
                            }
                        }
                    }
                    if (detectedUrl) break;
                }
            }

            if (detectedUrl) {
                console.log("SNIPER CHỈNH XÁC! Tìm thấy link:", detectedUrl);
                showToast("SNIPER: ĐÃ TÚM ĐƯỢC LINK!", 'success');
                chrome.runtime.sendMessage({ 
                    action: "TAGGING_COMPLETE", 
                    jobId: jobId, 
                    youtubeLink: detectedUrl 
                });
                
                // Dọn dẹp
                await chrome.storage.local.remove('pendingExtractionJobId');
                sessionStorage.removeItem('isShopeeTaggerJobInstance');
                sessionStorage.removeItem('shopeeTaggerRetryCount');
                linkFound = true;
                break;
            }
            await sleep(200);
        }

        if (!linkFound) {
            retryCount++;
            if (retryCount >= 3) { // Sau ~6 giây (3 lượt) không thấy thì bỏ cuộc
                console.error("TIMEOUT: Không thấy link sau 5-6 giây. Dừng lại.");
                showToast("KHÔNG TÌM THẤY LINK SAU 5S. ĐÃ DỪNG LẠI.", 'error');
                
                chrome.runtime.sendMessage({ action: "TAGGING_ERROR", jobId: jobId, error: "Timeout: Không thấy link after 3 attempts" });
                
                await chrome.storage.local.remove('pendingExtractionJobId');
                sessionStorage.removeItem('isShopeeTaggerJobInstance');
                sessionStorage.removeItem('shopeeTaggerRetryCount');
            } else {
                sessionStorage.setItem('shopeeTaggerRetryCount', retryCount.toString());
                console.log(`Chưa thấy link (Lượt ${retryCount}/3). Reloading...`);
                location.reload(); 
            }
        }
    } catch (e) {
        console.error("Lỗi trích xuất:", e);
        chrome.runtime.sendMessage({ action: "TAGGING_ERROR", jobId: jobId, error: e.message });
    }
}
}
