from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
import uuid
import time
from collections import deque
import os
import json
from datetime import datetime

app = FastAPI(title="YouTube Shopping Extension API")

def get_is_maintenance():
    # Bảo trì tự động nếu không có bot (Extension) kết nối trong 10 giây
    last_heartbeat = global_stats.get("last_bot_heartbeat", 0)
    if last_heartbeat == 0: # Chưa bao giờ kết nối
        return True
    
    heartbeat_age = time.time() - last_heartbeat
    if heartbeat_age > 60: # Quay lại 60s để ổn định với Service Worker V3
        return True
    return False

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Hàng đợi và kết quả theo job_id ---
JOB_TTL = 180                       # Thời gian chờ tối đa (giây)
job_queue: deque = deque()          # Hàng đợi chờ xử lý: [{"job_id", "url", "sub_id"}]
job_results: dict = {}              # Kết quả: {job_id: {"status", "youtube_link", "error"}}
emulator_commands: deque = deque()  # Hàng đợi lệnh cho Emulator: ["RELOAD", ...]
job_history: deque = deque(maxlen=30) # Lịch sử hoạt động (30 dòng gần nhất)
history_counter = 0

# --- THAY ĐỔI LINK CỦA BẠN TẠI ĐÂY ---
ZALO_LINK = "https://zalo.me/g/dpvvjy561"
YOUTUBE_LINK = "https://youtube.com/shopcollection/SCUCRmBaJUNvFvMmbln7TBzmH7gk5YXlO3wJA?si=4_mkvFsa9v0KPjHt"

# --- Thống kê ---
global_stats = {
    "total_requests": 0,
    "completed_jobs": 0,
    "errors": 0,
    "start_time": time.time(),
    "last_bot_heartbeat": 0  # Theo dõi lần cuối bot (Extension/Phone) kết nối
}

def add_to_history(msg):
    global history_counter
    history_counter += 1
    now = datetime.now().strftime("[%H:%M:%S %d/%m/%Y]")
    entry = f"{history_counter}- {now} - {msg}"
    job_history.append(entry) # Hiện cái mới nhất ở cuối


class LinkRequest(BaseModel):
    url: str
    sub_id: str = ""

class YoutubeResponse(BaseModel):
    job_id: str
    yt_link: str
    error: str | None = None

class LogData(BaseModel):
    html: str


@app.post("/log-dom")
async def log_dom(data: LogData):
    """Lưu DOM HTML do extension gửi về để debug."""
    with open("dom_dump.txt", "w", encoding="utf-8") as f:
        f.write(data.html)
    return {"status": "ok"}

@app.post("/request-conversion")
async def request_conversion(req: LinkRequest):
    """Streamlit gọi để yêu cầu convert 1 link. Trả về job_id."""
    # Bỏ kiểm tra heartbeat do đổi sang Extension
    # is_processing = any(res.get("status") == "processing" for res in job_results.values())
    # if heartbeat_age > 60 and not is_processing:
    #     return {"job_id": None, "status": "maintenance", "error": "Hệ thống đang bảo trì"}
    
    job_id = str(uuid.uuid4())
    job_queue.append({
        "job_id": job_id,
        "url": req.url,
        "sub_id": req.sub_id,
        "created_at": time.time()
    })
    global_stats["total_requests"] += 1
    job_results[job_id] = {
        "status": "pending", 
        "youtube_link": None, 
        "error": None,
        "shopee_url": req.url,
        "detailed_status": "",
        "created_at": time.time()
    }
    return {"job_id": job_id, "status": "pending"}


@app.get("/get-pending-link")
async def get_pending_link():
    """Extension polling để lấy job tiếp theo trong queue."""
    now = time.time()
    global_stats["last_bot_heartbeat"] = now  # Cập nhật heartbeat khi có bot kết nối
    try:

        # Dọn job cũ quá TTL
        while job_queue and (now - job_queue[0]["created_at"] > JOB_TTL):
            old = job_queue.popleft()
            if job_results.get(old["job_id"], {}).get("status") in ("pending", "processing"):
                job_results[old["job_id"]] = {"status": "error", "youtube_link": None, "error": "Hết thời gian chờ", "created_at": old["created_at"]}

        # --- KIỂM TRA XỬ LÝ TUẦN TỰ ---
        for i, job in enumerate(job_queue):
            job_id = job["job_id"]
            if job_results.get(job_id, {}).get("status") == "processing":
                # Kiểm tra xem job này có bị stuck không (quá 45s - cao hơn timeout 40s của UI một chút)
                elapsed = now - job.get("picked_at", now)
                if elapsed > 45:
                    print(f"⚠️ Job {job['job_id']} bị stuck, HỦY LỆNH để tránh tắc nghẽn.")
                    if job_id in job_results:
                        job_results[job_id].update({
                            "status": "error",
                            "error": "Có lỗi xảy ra, vui lòng gắn lại mã."
                        })
                    # Xoá khỏi queue để link tiếp theo có thể chạy
                    del job_queue[i]
                    continue # Bỏ qua job lỗi, tiếp tục vòng lặp để lấy job #2, #3 lên làm ngay lập tức
                else:
                    return {"has_link": False, "status": "processing"}

        # Tìm job đầu tiên "pending" để cấp cho bot
        for job in job_queue:
            job_id = job["job_id"]
            if job_results.get(job_id, {}).get("status") == "pending":
                job_results[job_id]["status"] = "processing"
                job_results[job_id]["picked_at"] = now  # Lưu thời điểm bot bắt đầu xử lý
                job["picked_at"] = now
                return {
                    "has_link": True,
                    "job_id": job_id,
                    "shopee_url": job["url"],
                    "sub_id": job.get("sub_id", "")
                }

        return {"has_link": False}
    except Exception as e:
        print(f"🔥 LỖI SERVER TRONG get_pending_link: {str(e)}")
        return {"has_link": False, "error": str(e)}


@app.post("/submit-youtube-link")
async def submit_youtube_link(res: YoutubeResponse):
    """Extension trả kết quả về kèm job_id."""
    global_stats["last_bot_heartbeat"] = time.time()  # Cập nhật heartbeat khi có kết quả trả về
    job_id = res.job_id
    if job_id not in job_results:
        raise HTTPException(status_code=404, detail="Job not found")

    # Xoá job khỏi queue
    for i, job in enumerate(job_queue):
        if job["job_id"] == job_id:
            del job_queue[i]
            break

    yt_link = res.yt_link
    if yt_link.startswith("ERROR:"):
        error_msg = yt_link.replace("ERROR:", "").strip()
        
        # --- TỰ ĐỘNG SỬA THÔNG BÁO LỖI THEO YÊU CẦU ---
        if "vui lòng đổi shop khác" in error_msg.lower():
            error_msg = "Shop bạn gửi không hỗ trợ mã, tìm sản phẩm này trên shop khác và thử lại."
            add_to_history("Lỗi gắn mã, vui lòng đổi shop khác.")
        else:
            add_to_history(f"Lỗi: {error_msg}")
            
        job_results[job_id].update({
            "status": "error", 
            "youtube_link": None, 
            "error": error_msg, 
            "shopee_url": job_results[job_id].get("shopee_url")
        })
    else:
        # Nếu yt_link là "SUCCESS" hoặc link thật, coi là Complete
        job_results[job_id].update({
            "status": "complete", 
            "youtube_link": yt_link, 
            "error": None
        })
        global_stats["completed_jobs"] += 1
        add_to_history("Thành công")

    return {"message": "Result received"}

@app.get("/maintenance-status")
async def maintenance_status():
    return {"is_maintenance": get_is_maintenance()}

@app.get("/check-status")
async def check_status(job_id: str):
    """Streamlit kiểm tra tiến độ theo job_id."""
    if job_id not in job_results:
        raise HTTPException(status_code=404, detail="Job not found")
    
    result = job_results[job_id]
    now = time.time()
    created_at = result.get("created_at", now)

    # --- KIỂM TRA TIMEOUT 40 GIÂY (Chỉ tính khi đang xử lý, không tính hàng chờ) ---
    if result["status"] == "processing":
        picked_at = result.get("picked_at")
        if picked_at and (now - picked_at) > 40:
            result["status"] = "error"
            result["error"] = "Có lỗi xảy ra, vui lòng gắn lại mã."
            # Xoá khỏi queue nếu còn
            for i, job in enumerate(job_queue):
                if job["job_id"] == job_id:
                    del job_queue[i]
                    break
    # Tính vị trí trong hàng đợi
    queue_pos = 0
    if result["status"] == "pending":
        for i, q_job in enumerate(job_queue):
            if q_job["job_id"] == job_id:
                queue_pos = i + 1
                break
    
    return {
        "status": result["status"],
        "youtube_link": result["youtube_link"],
        "error": result["error"],
        "shopee_url": result.get("shopee_url"),
        "detailed_status": result.get("detailed_status", ""),
        "queue_position": queue_pos
    }

@app.post("/submit-detailed-status")
async def submit_detailed_status(data: dict):
    job_id = data.get("job_id")
    message = data.get("message")
    if job_id in job_results:
        job_results[job_id]["detailed_status"] = message
        return {"ok": True}
    return {"ok": False, "error": "Job not found"}

@app.get("/get-tagged-job")
async def get_tagged_job():
    """Browser/Emulator polling để lấy job (ưu tiên job đã tagged hoặc pending trực tiếp)."""
    # 1. Ưu tiên job đã qua bước Emulator xử lý (status = tagged)
    for job_id, res in job_results.items():
        if res["status"] == "tagged":
            res["status"] = "extracting"
            return {
                "has_job": True,
                "job_id": job_id,
                "shopee_url": res.get("shopee_url")
            }
    
    # 2. Hỗ trợ lấy trực tiếp job mới từ Web (status = pending) cho tagger.js trên trình duyệt
    for job_id, res in job_results.items():
        if res["status"] == "pending":
            res["status"] = "extracting"
            # Xoá khỏi queue để không bị bot khác lấy mất
            for i, job in enumerate(job_queue):
                if job["job_id"] == job_id:
                    del job_queue[i]
                    break
            return {
                "has_job": True,
                "job_id": job_id,
                "shopee_url": res.get("shopee_url")
            }
            
    return {"has_job": False}

@app.post("/submit-final-link")
async def submit_final_link(res: YoutubeResponse):
    """Emulator trả kết quả link affiliate cuối cùng."""
    job_id = res.job_id
    if job_id not in job_results:
        raise HTTPException(status_code=404, detail="Job not found")
    
    if res.error:
        job_results[job_id].update({"status": "error", "error": res.error})
        global_stats["errors"] += 1
    else:
        job_results[job_id].update({"status": "complete", "youtube_link": res.yt_link, "error": None})
        global_stats["completed_jobs"] += 1
    
    return {"message": "Final result received"}


@app.post("/submit-cleanup-done")
async def submit_cleanup_done(data: dict):
    """Extension gọi sau khi Dọn dẹp xong để báo Emulator chuẩn bị."""
    job_id = data.get("job_id")
    print(f"🧹 Cleanup DONE for job {job_id}. Queueing RELOAD for Emulator.")
    emulator_commands.append("RELOAD_YOUTUBE")
    return {"message": "Cleanup signal received"}

@app.get("/get-emulator-command")
async def get_emulator_command():
    """Emulator polling để lấy lệnh đặc biệt (như RELOAD)."""
    if emulator_commands:
        cmd = emulator_commands.popleft()
        return {"has_command": True, "command": cmd}
    return {"has_command": False}


@app.get("/stats")
async def get_stats():
    """Xem thống kê lượt nhập link."""
    uptime_sec = time.time() - global_stats["start_time"]
    uptime_min = round(uptime_sec / 60, 1)
    last_hb = global_stats["last_bot_heartbeat"]
    hb_age = round(time.time() - last_hb) if last_hb > 0 else "Chưa có"
    return {
        "tong_luot_nhap_link": global_stats["total_requests"],
        "so_link_thanh_cong": global_stats["completed_jobs"],
        "so_link_bi_loi": global_stats["errors"],
        "thoi_gian_server_chay_phut": uptime_min,
        "last_heartbeat_age": hb_age,
        "ghi_chu": "Du lieu se reset khi Server Render khoi dong lai."
    }


@app.get("/debug")
async def debug_state():
    """Xem trạng thái bộ nhớ hiện tại (debug)."""
    return {
        "job_queue_len": len(job_queue),
        "job_queue": list(job_queue),
        "job_results": job_results
    }

@app.get("/get-history")
async def get_history():
    """Lấy danh sách lịch sử hoạt động."""
    return {"history": list(job_history)}

@app.get("/admin-logs", response_class=HTMLResponse)
async def admin_logs():
    """Trang quản trị xem lịch sử hoạt động riêng tư."""
    return f"""
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <title>Admin Logs - Shopee YT Tool</title>
    <style>
        body {{ background: #121212; color: #00ff00; font-family: 'Courier New', Courier, monospace; padding: 20px; }}
        h2 {{ color: #fff; border-bottom: 1px solid #333; padding-bottom: 10px; }}
        #log-container {{ background: #1e1e1e; padding: 15px; border-radius: 8px; border: 1px solid #333; height: 85vh; overflow-y: auto; line-height: 1.6; font-size: 0.95rem; }}
    </style>
</head>
<body>
    <h2>📜 LỊCH SỬ HOẠT ĐỘNG HỆ THỐNG</h2>
    <div id="log-container">Đang tải dữ liệu...</div>
    <script>
        async function updateLogs() {{
            try {{
                const res = await fetch('/get-history');
                const data = await res.json();
                const container = document.getElementById('log-container');
                container.innerHTML = data.history.join('<br>') || 'Chưa có hoạt động nào.';
                container.scrollTop = container.scrollHeight;
            }} catch(e) {{}}
        }}
        setInterval(updateLogs, 3000);
        updateLogs();
    </script>
</body>
</html>
"""

@app.get("/reset-all")
async def reset_all():
    """Reset sạch sẽ hàng đợi và kết quả."""
    job_queue.clear()
    job_results.clear()
    return {"message": "Đã reset sạch sẽ hệ thống."}


# --- Trang Giao diện Siêu nhẹ (Zalo Compatible) ---
@app.get("/", response_class=HTMLResponse)
async def get_ui():
    is_maintenance = get_is_maintenance()
    status_msg = "⚠️ Đang Bảo Trì Hệ Thống. Vui lòng quay lại sau!" if is_maintenance else ""
    status_type = "error"
    display_style = "block" if is_maintenance else "none"

    html_content = f"""
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mã YouTube Shopee</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: #f0f2f5;
            color: #31333f;
            margin: 0;
            padding: 20px;
            display: flex;
            flex-direction: column;
            align-items: center;
        }}
        .container {{
            max-width: 600px;
            width: 100%;
        }}
        .header-title {{
            color: #212121;
            text-align: center;
            font-weight: 900;
            font-size: 3rem;
            margin: 20px 0;
            display: flex;
            flex-direction: row;
            align-items: center;
            justify-content: center;
            gap: 15px;
            width: 100%;
            white-space: nowrap;
        }}
        @media (max-width: 480px) {{
            .header-title {{ font-size: 1.8rem; gap: 8px; }}
        }}
        .btn-zalo {{
            background-color: #0068ff;
            color: white;
            padding: 12px;
            border-radius: 8px;
            text-align: center;
            font-weight: 700;
            margin-bottom: 12px;
            text-decoration: none;
            display: block;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}
        .btn-yt {{
            background-color: #ff0000;
            color: white;
            padding: 12px;
            border-radius: 8px;
            text-align: center;
            font-weight: 700;
            margin-bottom: 20px;
            text-decoration: none;
            display: block;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}
        .input-group {{
            background: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }}
        label {{
            display: block;
            font-size: 0.9rem;
            margin-bottom: 8px;
            font-weight: 500;
        }}
        input {{
            width: 100%;
            padding: 12px;
            border: 2px solid #ff0000;
            border-radius: 6px;
            box-sizing: border-box;
            font-size: 1rem;
            margin-bottom: 15px;
            background-color: #f8f9fa;
        }}
        button#convert-btn {{
            background-color: #ff0000;
            color: white;
            border: none;
            padding: 12px 25px;
            border-radius: 6px;
            font-weight: 700;
            cursor: pointer;
            font-size: 1rem;
            width: 100%;
            transition: background 0.2s;
        }}
        button#convert-btn:disabled {{
            background-color: #ccc;
        }}
        .status-box {{
            padding: 15px;
            border-radius: 8px;
            margin-top: 20px;
            display: {display_style};
        }}
        .status-pending {{ background-color: #fff3cd; color: #856404; border: 1px solid #ffeeba; }}
        .status-success {{ background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }}
        .status-error {{ background-color: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }}
        .result-area {{
            margin-top: 15px;
            display: none;
        }}
        .result-link {{
            display: none !important; /* Xoá hiển thị link triệt để */
            word-break: break-all;
            background: #eee;
            padding: 10px;
            border-radius: 4px;
            font-family: monospace;
            margin-bottom: 10px;
        }}
        .action-btns {{
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }}
        .btn-action {{
            padding: 10px;
            border-radius: 6px;
            text-align: center;
            text-decoration: none;
            font-weight: 600;
            font-size: 0.9rem;
        }}
        .btn-copy {{ background: #28a745; color: white; border: none; cursor: pointer; }}
        .btn-open {{ background: #ff0000; color: white; }}
        
        /* Hiệu ứng dấu chấm nháy */
        .dots span {{
            animation: blink 1.4s infinite both;
        }}
        .dots span:nth-child(2) {{ animation-delay: 0.2s; }}
        .dots span:nth-child(3) {{ animation-delay: 0.4s; }}
        @keyframes blink {{
            0% {{ opacity: .2; }}
            20% {{ opacity: 1; }}
            100% {{ opacity: .2; }}
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header-title">
            <svg class="yt-icon" viewBox="0 0 2859 2000" style="width: 45px; height: 45px; flex-shrink: 0;">
                <path fill="#FF0000" d="M2790.8 311.2c-32.3-121.1-127.1-216-248.2-248.2C2323.9 0 1429.5 0 1429.5 0S535 0 316.4 63C195.3 95.2 100.5 190.1 68.2 311.2 0 529.8 0 985 0 985s0 455.2 68.2 673.8c32.3 121.1 127.1 216 248.2 248.2 218.6 63 1113.1 63 1113.1 63s894.4 0 1113.1-63c121.1-32.3 216-127.1 248.2-248.2 68.2-218.6 68.2-673.8 68.2-673.8s0-455.2-68.2-673.8"/>
                <path fill="#FFF" d="M1142.4 1416.3l742.8-431.3-742.8-431.3z"/>
            </svg>
            <span>Mã YouTube Shopee</span>
        </div>

        <a href="{ZALO_LINK}" target="_blank" class="btn-zalo">💬 THAM GIA NHÓM ZALO HỖ TRỢ</a>

        <div class="input-group">
            <label>Dán Link sản phẩm cần lấy mã vào đây 👇</label>
            <input type="text" id="shopee-url" placeholder="https://vn.shp.ee/..." {"disabled" if is_maintenance else ""}>
            <button id="convert-btn" onclick="startConversion()" {"disabled" if is_maintenance else ""}>⚡ Gắn Mã</button>
        </div>

        <div id="status-box" class="status-box status-{status_type}">{status_msg}</div>

        <div id="heartbeat-debug" style="font-size: 0.75rem; color: #888; text-align: center; margin-top: 10px;">
            Đang kiểm tra kết nối Extension...
        </div>

        <div id="result-area" class="result-area">
            <div id="result-link" class="result-link"></div>
            <div class="action-btns">
                <a id="open-link" href="#" target="_blank" class="btn-action btn-open">🌍 Mở Link Lấy Mã</a>
                <button class="btn-action btn-copy" onclick="copyLink()">📋 Copy Link</button>
            </div>
        </div>
    </div>

    <script>
        let currentJobId = null;
        let pollInterval = null;
        let processingStartTime = 0; // Thời điểm bắt đầu xử lý (reset mỗi khi gửi yêu cầu mới)
        const dotHtml = '<span class="dots"><span>.</span><span>.</span><span>.</span></span>';

        async function startConversion() {{
            // Reset state cho yêu cầu mới ngay lập tức
            if (pollInterval) clearInterval(pollInterval);
            currentJobId = null;
            processingStartTime = 0;

            const urlInput = document.getElementById('shopee-url');
            const url = urlInput.value.trim();
            if (!url) return alert('Vui lòng nhập link Shopee!');

            // Link Validation
            const isVideo = url.includes('?smtt=0');
            const isValidFormat = url.toLowerCase().includes('vn.shp.ee') || url.toLowerCase().includes('s.shopee.vn');

            if (isVideo) {{
                showStatus('⚠️ Vui lòng nhập link sản phẩm, đây là Link video.', 'error');
                return;
            }}
            if (!isValidFormat) {{
                showStatus('❌ vui lòng nhập đúng link sản phẩm shopee', 'error');
                return;
            }}

            const btn = document.getElementById('convert-btn');
            btn.disabled = true;
            btn.innerHTML = '⌛ ĐANG XỬ LÝ' + dotHtml;

            showStatus('⌛ Đã gửi yêu cầu, Đang chờ xử lý' + dotHtml + ' từ 10-20s', 'pending');
            document.getElementById('result-area').style.display = 'none';

            try {{
                const response = await fetch('/request-conversion', {{
                    method: 'POST',
                    headers: {{ 'Content-Type': 'application/json' }},
                    body: JSON.stringify({{ url: url }})
                }});
                const data = await response.json();
                
                if (data.status === 'maintenance') {{
                    showStatus('⚠️ Đang Bảo Trì Hệ Thống. Vui lòng quay lại sau!', 'error');
                    resetButton();
                    return;
                }}
                
                currentJobId = data.job_id;
                
                pollInterval = setInterval(checkStatus, 2000);
            }} catch (err) {{
                showStatus('❌ Lỗi kết nối Server!', 'error');
                resetButton();
            }}
        }}

        async function checkStatus() {{
            if (!currentJobId) return;

            try {{
                const response = await fetch(`/check-status?job_id=${{currentJobId}}`);
                const data = await response.json();

                if (data.status === 'processing' && processingStartTime === 0) {{
                    processingStartTime = Date.now(); // Bắt đầu tính timeout 40s khi bot nhận link
                }}

                if (data.status === 'complete') {{
                    clearInterval(pollInterval);
                    showStatus('✅ GẮN MÃ THÀNH CÔNG!', 'success');
                    showResult(data.youtube_link);
                    resetButton();
                }} else if (data.status === 'error' || (processingStartTime > 0 && (Date.now() - processingStartTime) > 40000)) {{
                    clearInterval(pollInterval);
                    const errorMsg = (processingStartTime > 0 && (Date.now() - processingStartTime) > 40000) ? 'Có lỗi xảy ra, vui lòng gắn lại mã.' : data.error;
                    showStatus('❌ LỖI: ' + errorMsg, 'error');
                    resetButton();
                }} else {{
                    // Chỉ hiển thị hàng đợi, ẩn chi tiết
                    let msg = '⏳ Đang chờ xử lý' + dotHtml + ' từ 10-20s';
                    if (data.queue_position > 0) msg = `⏳ Bạn đang ở vị trí thứ ${{data.queue_position}} trong hàng đợi` + dotHtml;
                    showStatus(msg, 'pending');
                }}
            }} catch (err) {{
                console.error('Polling error:', err);
            }}
        }}

        function showStatus(msg, type) {{
            const box = document.getElementById('status-box');
            box.style.display = 'block';
            box.innerHTML = msg;
            box.className = 'status-box status-' + type;
        }}

        function showResult(link) {{
            const area = document.getElementById('result-area');
            area.style.display = 'block';
            document.getElementById('result-link').innerText = link;
            document.getElementById('open-link').href = link;
            // Xoá link ở ô nhập cho sạch giao diện
            document.getElementById('shopee-url').value = '';
        }}

        function resetButton() {{
            const btn = document.getElementById('convert-btn');
            btn.disabled = false;
            btn.innerText = '⚡ Gắn Mã';
        }}

        function copyLink() {{
            const link = document.getElementById('result-link').innerText;
            navigator.clipboard.writeText(link).then(() => {{
                alert('Đã chép mã thành công!');
            }});
        }}

        // Kiểm tra bảo trì tự động mỗi 10 giây
        setInterval(async () => {{
            try {{
                const response = await fetch('/maintenance-status');
                const data = await response.json();
                const btn = document.getElementById('convert-btn');
                const input = document.getElementById('shopee-url');
                const hbDebug = document.getElementById('heartbeat-debug');
                
                // Cập nhật thông tin Heartbeat
                const statsRes = await fetch('/stats');
                const stats = await statsRes.json();
                hbDebug.innerHTML = `💓 Tín hiệu Extension: ${{stats.last_heartbeat_age}} giây trước (Yêu cầu Extension trỏ về: ${{window.location.origin}})`;

                if (data.is_maintenance) {{
                    showStatus('⚠️ Đang Bảo Trì Hệ Thống. Vui lòng quay lại sau!', 'error');
                    btn.disabled = true;
                    input.disabled = true;
                }} else if (!currentJobId) {{
                    // Chỉ ẩn nếu không có job nào đang poll
                    const box = document.getElementById('status-box');
                    if (box.innerText.includes('Bảo Trì')) {{
                         box.style.display = 'none';
                         btn.disabled = false;
                         input.disabled = false;
                    }}
                }}
            }} catch (err) {{}}
        }}, 5000); // Tăng tần suất lên 5s để debug nhanh
    </script>
</body>
</html>
"""
    return html_content

if __name__ == "__main__":
    import uvicorn
    # Chạy trên 0.0.0.0 để Chrome Extension dễ kết nối
    uvicorn.run(app, host="0.0.0.0", port=8002)
