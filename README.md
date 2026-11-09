# 巴哈動畫瘋 廣告跳過 + 下一集預熱

一個 Tampermonkey 使用者腳本，用於 [巴哈姆特動畫瘋](https://ani.gamer.com.tw/)。核心功能：

- **本集去廣告**：開頭廣告自動看完 25 秒（靜音），到點自動跳過、直接進入正片。
- **下一集預熱**：本集播放到「剩餘 8 分鐘」時，後台自動替「下一集」過掉廣告，點下一集即無廣告直接播放。

---

## 運作原理

### 廣告驗證是「服務端按設備+集數記錄」的

動畫瘋的廣告驗證由**服務端按 `(deviceid, 集數 sn)` 記錄**：`token.php` 回傳 `time==1` 代表「這台設備、這一集」的廣告已通過。因此，只要用播放器**同一個 deviceid** 對「下一集」走完廣告流程，服務端就會把下一集標記為已看廣告，等你切過去時直接放正片。

### 關鍵門檻：服務端 25 秒

非 VIP 帳號要拿到影片流，必須滿足服務端 **25 秒**的廣告觀看門檻（低於 25 秒，`token.php` 不會返回 `time==1`，正片無法載入）。這是服務端硬性校驗，前端無法縮短。

### 關鍵障礙：服務端「一設備一視頻」鎖

動畫瘋對每個 deviceid 設有 **「同時間內僅提供播放一部影片」** 的設備鎖。若在看第 1 集時，直接對第 2 集發起廣告計數，會撞鎖被拒絕。

因此預熱前必須先**釋放設備鎖**（參考 [miyouzi/aniGamerPlus](https://github.com/miyouzi/aniGamerPlus) 的流程）。

---

## 完整運行邏輯

### 1. 捕獲 deviceid

腳本攔截 `fetch` / `XHR`，從以下兩處捕獲播放器真實使用的 deviceid（保證與播放器 100% 一致）：

- `GET /ajax/getdeviceid.php` 的響應 `{ deviceid }`
- 播放器載正片前必發的 `token.php?sn=..&device=..` 請求參數

### 2. 本集去廣告（25 秒自動完成）

- 攔截 `player.adHandler().play()`，捕獲廣告生命週期與 `onComplete` 回調。
- 攔截 `animeAd` / `nativeAd` 插件：把倒數參數鎖到 25 秒、壓制 `error`（防止回退 Google Ads）、`end` 時觸發完結。
- 廣告期間強制靜音；滿足 25 秒後自動發送 `videoCastcishu.php?...&ad=end`，再調用 `onComplete()` 載入正片。

### 3. 片尾觸發預熱（剩 8 分鐘）

- 輪詢 + `seeked` / `timeupdate` 事件監聽（拖進度條立即觸發，方便續看與測試）。
- 觸發條件：**正片播放中、時長 >10 分鐘（排除 30 秒廣告）、剩餘 ≤8 分鐘**。
- 兼容 HLS 串流的 `duration === Infinity`：回退用 `seekable.end()` 與 `player.duration()` 取得總時長。

### 4. 後台預熱下一集（完整流程）

```
1. token.php?sn=<下一集>&device=..        # 檢查是否 VIP / 已通過
   ├─ VIP 或 time==1 → 直接結束（無需預熱）
   └─ 否則繼續 ↓
2. unlock.php?sn=<下一集>&ttl=0           # 釋放設備鎖
3. checklock.php?device=..&sn=<下一集>    # 確認鎖狀態
4. unlock.php ×2                          # 補償釋放（與 AniGamerPlus 一致）
5. videoCastcishu.php?sn=<下一集>&s=194699 # 開始廣告計時
6. 等待 26 秒（>25s 門檻）
7. videoCastcishu.php?...&ad=end          # 結束廣告
8. token.php 查詢 → time==1 則「預熱成功」
   └─ 若尚未通過，才補發 videoStart.php 並重試 token
9. 無論成敗都 unlock.php 釋放設備鎖        # 讓設備回到當前集，避免搶佔
```

> **為何步驟 8 要「先查 token、必要時才 videoStart」？** 因為 `videoStart` 會把設備登記為「正在播放下一集」，與當前正在播的這集衝突，正是「本服務同時間內僅提供播放一部影片！」的來源。能只靠廣告計數（`videoCastcishu` + `ad=end`）就讓 `token.php` 通過時，就不調 `videoStart`，最大限度避開鎖衝突。

預熱成功後，`S.warming`（頁面內 Set）記錄該集，防止重複預熱。

---

## 安裝

1. 安裝 [Tampermonkey](https://www.tampermonkey.net/)。
2. 開啟 [ani-gamer-ad-skip-warmup.user.js](./ani-gamer-ad-skip-warmup.user.js)，點擊 **Raw**，Tampermonkey 會自動彈出安裝頁面。
3. 點「安裝」，刷新任一集動畫頁面即生效。

也可手動：Tampermonkey 儀表板 → 「+」新增腳本 → 貼上檔案內容 → 儲存。

---

## 行為說明

| 功能 | 說明 |
| --- | --- |
| 本集去廣告 | 開頭廣告自動倒數 25 秒、靜音，到點自動跳過進正片 |
| 年齡分級確認 | 自動隱藏各種分級提示遮罩（12/15/18 歲通用），並點確認放行；按文本+容器語義雙重匹配，排除「未滿」 |
| 下一集預熱 | 本集剩 8 分鐘時，後台釋放設備鎖、替下一集過廣告 |
| 拖進度條 | 支援拖到片尾快速測試 / 續看，`seeked` 立即觸發檢查 |
| 切集武裝 | 切集後先等新集 `currentTime` 回到開頭（<60s）才恢復預熱判斷，避免用上一集殘留進度誤觸發 |
| 防重複 | 頁面內 `warming` Set 防止重複預熱同一集 |
| 切集偵測 | URL 的 `sn` 變化時自動重置預熱狀態（相容播放器「下一集」按鈕） |

---

## 限制

- 僅適用於**非 VIP** 帳號（VIP 本身無廣告，腳本自動跳過預熱）。
- 需在**台灣 IP** 環境（動畫瘋有地區限制）。
- 預熱只能讓「下一集」無廣告，**無法免除當下這集的廣告**（服務端 25 秒門檻決定）。
- 若看一集停頓超過設備鎖有效期，可能需重新預熱（服務端機制，非腳本可控制）。

## 測試環境

- Chrome / Edge + Tampermonkey
- Windows

## 致謝

廣告流程端點、25 秒門檻、設備鎖釋放流程參考 [miyouzi/aniGamerPlus](https://github.com/miyouzi/aniGamerPlus)。

## License

MIT
