document.addEventListener('DOMContentLoaded', () => {
  const toggleBtn = document.getElementById('toggleBtn');
  const statusEl = document.getElementById('status');
  
  // Load initial state
  chrome.storage.local.get(['isAutoTagging'], (result) => {
    const isRunning = result.isAutoTagging !== false; // Default to true
    updateUI(isRunning);
  });
  
  toggleBtn.addEventListener('click', () => {
    chrome.storage.local.get(['isAutoTagging'], (result) => {
      const currentState = result.isAutoTagging !== false; // Default to true
      const newState = !currentState;
      chrome.storage.local.set({ isAutoTagging: newState }, () => {
        updateUI(newState);
      });
    });
  });
  
  function updateUI(isRunning) {
    if (isRunning) {
      statusEl.textContent = 'Trạng thái: ĐANG CHẠY';
      statusEl.className = 'status running';
      toggleBtn.textContent = 'TẮT TỰ ĐỘNG GẮN THẺ';
      toggleBtn.style.backgroundColor = '#666';
    } else {
      statusEl.textContent = 'Trạng thái: ĐÃ DỪNG';
      statusEl.className = 'status stopped';
      toggleBtn.textContent = 'BẬT TỰ ĐỘNG GẮN THẺ';
      toggleBtn.style.backgroundColor = '#ff0000';
    }
  }
});
