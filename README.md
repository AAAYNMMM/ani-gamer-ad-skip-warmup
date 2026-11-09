# 巴哈動畫瘋 廣告跳過 + 下一集預熱

一個 Tampermonkey 使用者腳本，用於 [巴哈姆特動畫瘋](https://ani.gamer.com.tw/)：
- **25 秒自動看完開頭廣告**，廣告期間靜音，倒數結束自動點擊跳過、直接進入正片。
- **後台預熱下一集**：看本集時，腳本自動在背景替「下一集」過掉廣告，從下一集起無廣告直接播放。

## 原理

動畫瘋的廣告驗證是**服務端按 `(deviceid, 集數 sn)` 記錄**的：`token.php` 回傳 `time==1` 表示「這台設備、這一集」的廣告已通過。

因此，腳本捕獲播放器真實使用的 `deviceid`，在你看本集時，於背景對下一集 `sn` 走一遍完整廣告流程：

```
videoCastcishu.php?sn=<下一集>&s=194699   # 開始廣告計時
→ 等待 26 秒（服務端門檻 25 秒）
→ videoCastcishu.php?...&ad=end          # 結束廣告
→ videoStart.php?sn=<下一集>
→ 反覆查 token.php 直到 time==1          # 確認已通過
```

等你切到下一集，`token.php` 直接回傳 `time==1`，**無廣告直接播正片**。

> ⚠️ 預熱只能讓「從下一集起」無廣告，**無法免除第一集 / 當下這集的廣告**——這是服務端 25 秒門檻決定的。想要第一集也秒進，只有付費 VIP。

## 安裝

1. 安裝瀏覽器擴充套件 [Tampermonkey](https://www.tampermonkey.net/)。
2. 開啟 [ani-gamer-ad-skip-warmup.user.js](./ani-gamer-ad-skip-warmup.user.js)，點擊 **Raw** 按鈕，Tampermonkey 會自動彈出安裝頁面。
3. 點擊「安裝」，之後刷新任一集動畫頁面即可生效。

也可以手動：Tampermonkey 儀表板 → 「+」新增腳本 → 將本檔案內容全部貼上 → 儲存。

## 行為說明

| 功能 | 說明 |
| --- | --- |
| 本集去廣告 | 開頭廣告自動倒數 25 秒、靜音，結束自動跳過進正片 |
| 下一集預熱 | 看本集時後台替下一集過廣告，結果按 deviceid 快取，換帳號/清緩存自動失效 |
| 重複防護 | 已預熱過的集數不會重複預熱 |
| 無侵入 | 不改動播放器 UI，全程 Console 輸出進度（F12 可查看） |

## 相容性

- 僅適用於非 VIP 帳號（VIP 本身無廣告，腳本自動跳過預熱）。
- 需在台灣 IP 環境（動畫瘋有地區限制）。
- 測試環境：Chrome + Tampermonkey。

## 致謝

廣告流程端點與門檻參考 [miyouzi/aniGamerPlus](https://github.com/miyouzi/aniGamerPlus)。

## License

MIT
