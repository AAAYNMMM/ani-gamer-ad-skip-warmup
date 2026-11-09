// ==UserScript==
// @name         巴哈動畫瘋 廣告跳過 + 下一集預熱
// @namespace    https://ani.gamer.com.tw/
// @version      2.2.0
// @description  25秒自動看完廣告進正片；本集剩8分鐘時後台自動替「下一集」過廣告，從下一集起無廣告
// @author       you
// @match        https://ani.gamer.com.tw/animeVideo.php?sn=*
// @run-at       document-start
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const D = W.document;

    const CONFIG = {
        SKIP_SECONDS: 25,             // 本集廣告自動完成秒數
        BACKEND_ELAPSED_MS: 25300,    // 本集後端驗證安全門檻 (>=25s)
        WARMUP_WAIT_MS: 26000,        // 預熱等待秒數 (略高於25s保險)
        AD_SLOT: '194699',            // 廣告調度 ID (AniGamerPlus 固定值)
        WARMUP_RETRY: 8,              // 預熱 token 驗證重試次數
        WARMUP_RETRY_MS: 2000,        // 預熱 token 驗證重試間隔
        WARMUP_TRIGGER_REMAIN_SEC: 480 // 正片剩餘播放秒數達此門檻時觸發預熱 (8 分鐘)
    };

    const SEL = {
        container: '#ani_video',
        video: '#ani_video_html5_api',
        skipBtn: '#adSkipButton',
        vastBlocker: '.vast-blocker',
        adPlaying: 'vjs-anigamer-ad-playing',
        adPlayingGeneric: 'vjs-ad-playing'
    };

    // ---- 全域狀態 ----
    const S = {
        deviceId: null,        // 播放器真實使用的 deviceid
        cishuStart: 0,         // 本集廣告計時起點 (毫秒)
        currentSession: null,  // 本集廣告生命週期
        warming: new Set(),    // 正在預熱中的 sn (頁面內防重複)
        warmupStarted: false,  // 本頁是否已觸發過預熱
        _pollingStarted: false // 輪詢是否已啟動 (防重複)
    };

    // ---- 工具函式 ----
    function randStr(n) {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let s = '';
        for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
        return s;
    }

    function getCurrentSn() {
        const m = location.search.match(/[?&]sn=(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    // 從頁面「劇集列表」區塊 (section.season 的 <a href="?sn=...">) 解析全部集數
    function getEpisodeList() {
        const out = [];
        D.querySelectorAll('section.season a[href]').forEach(a => {
            const m = (a.getAttribute('href') || '').match(/[?&]sn=(\d+)/);
            if (m) out.push(parseInt(m[1], 10));
        });
        return Array.from(new Set(out));
    }

    function getNextSn() {
        const cur = getCurrentSn();
        const list = getEpisodeList();
        const i = list.indexOf(cur);
        if (i >= 0 && i + 1 < list.length) return list[i + 1];
        return null;
    }

    function domReady() {
        return D.readyState !== 'loading';
    }

    // ---- deviceid 捕獲 (保證與播放器一致) ----
    function setDevice(id) {
        if (!id || S.deviceId === id) return;
        S.deviceId = id;
        console.log('[動畫瘋] 捕獲 deviceid:', id);
        // 不在此處立即預熱，改由正片進度（剩8分鐘）觸發
    }
    function captureDeviceFromUrl(url) {
        if (typeof url !== 'string') return;
        // token.php?sn=..&device=.. 是播放器載正片前必發的請求，device 就是真身
        if (url.includes('token.php') && url.includes('device=')) {
            const m = url.match(/[?&]device=([^&]+)/);
            if (m) setDevice(decodeURIComponent(m[1]));
        }
    }
    // 統一處理攔截到的 URL
    function handleUrl(url) {
        if (typeof url !== 'string') return;
        // 記錄「本集」廣告計時起點；排除預熱對其他集發的請求，避免污染本集計時
        if (url.includes('/ajax/videoCastcishu.php') && !url.includes('ad=end')) {
            const m = url.match(/[?&]sn=(\d+)/);
            if (m && parseInt(m[1], 10) === getCurrentSn()) {
                S.cishuStart = Date.now();
            }
        }
        captureDeviceFromUrl(url);
    }

    // ---- 網路攔截：fetch ----
    const origFetch = W.fetch.bind(W);
    W.fetch = function (resource, init) {
        let url = '';
        try {
            url = typeof resource === 'string' ? resource : (resource && resource.url) || '';
        } catch (e) {}
        handleUrl(url);
        const p = origFetch(resource, init);
        try {
            if (url.includes('/ajax/getdeviceid.php')) {
                p.then(r => r.clone().json()).then(j => {
                    if (j && j.deviceid) setDevice(j.deviceid);
                }).catch(() => {});
            }
        } catch (e) {}
        return p;
    };

    // ---- 網路攔截：XHR ----
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        try {
            const u = String(url);
            handleUrl(u);
            if (u.includes('/ajax/getdeviceid.php')) {
                this.addEventListener('load', function () {
                    try {
                        const j = JSON.parse(this.responseText);
                        if (j && j.deviceid) setDevice(j.deviceid);
                    } catch (e) {}
                });
            }
        } catch (e) {}
        return origOpen.apply(this, arguments);
    };

    // ============================================================
    //  預熱核心：後台替下一集過廣告
    // ============================================================
    function maybeStartWarmup() {
        if (S.warmupStarted) return; // 本頁只觸發一次
        if (!S.deviceId) return;     // 還沒拿到 deviceid
        if (!domReady()) return;     // DOM 未就緒

        const next = getNextSn();
        if (next == null) {
            console.log('[動畫瘋] 無下一集可預熱');
            S.warmupStarted = true;
            return;
        }
        S.warmupStarted = true;
        warmup(next);
    }

    function warmup(sn) {
        if (!S.deviceId || S.warming.has(sn)) return;
        S.warming.add(sn);
        console.log('[動畫瘋] 開始後台預熱下一集 sn=' + sn);

        // 先查一次 token，判斷 VIP / 是否已通過
        fetch(`/ajax/token.php?sn=${sn}&device=${S.deviceId}&hash=${randStr(12)}`)
            .then(r => r.json())
            .then(j => {
                if (j && j.vip) {
                    console.log('[動畫瘋] VIP 帳號，無需預熱 sn=' + sn);
                    S.warming.delete(sn);
                    return;
                }
                if (j && j.time === 1) {
                    console.log('[動畫瘋] sn=' + sn + ' 已通過 (time==1)，無需預熱');
                    S.warming.delete(sn);
                    return;
                }
                runWarmupFlow(sn);
            })
            .catch(() => runWarmupFlow(sn));
    }

    function runWarmupFlow(sn) {
        // 1. 開始廣告計時
        fetch(`/ajax/videoCastcishu.php?sn=${sn}&s=${CONFIG.AD_SLOT}`)
            .catch(() => {})
            .then(() => {
                console.log('[動畫瘋] sn=' + sn + ' 廣告計時已開始，等待 ' + (CONFIG.WARMUP_WAIT_MS / 1000) + 's');
                // 2. 等滿 25s 門檻 (用 26s 保險)
                setTimeout(() => {
                    // 3. 結束廣告 + 4. videoStart
                    fetch(`/ajax/videoCastcishu.php?sn=${sn}&s=${CONFIG.AD_SLOT}&ad=end`)
                        .catch(() => {})
                        .then(() => fetch(`/ajax/videoStart.php?sn=${sn}`).catch(() => {}))
                        .then(() => verifyWarmup(sn, CONFIG.WARMUP_RETRY));
                }, CONFIG.WARMUP_WAIT_MS);
            });
    }

    function verifyWarmup(sn, tries) {
        fetch(`/ajax/token.php?sn=${sn}&device=${S.deviceId}&hash=${randStr(12)}`)
            .then(r => r.json())
            .then(j => {
                if (j && j.time === 1) {
                    console.log('[動畫瘋] ✔ 預熱成功！下一集 sn=' + sn + ' 已無廣告');
                    S.warming.delete(sn);
                } else if (tries > 0) {
                    // 未生效：重發 ad=end + videoStart 再查
                    fetch(`/ajax/videoCastcishu.php?sn=${sn}&s=${CONFIG.AD_SLOT}&ad=end`).catch(() => {})
                        .then(() => fetch(`/ajax/videoStart.php?sn=${sn}`).catch(() => {}))
                        .then(() => setTimeout(() => verifyWarmup(sn, tries - 1), CONFIG.WARMUP_RETRY_MS));
                } else {
                    console.warn('[動畫瘋] ✘ 預熱失敗 sn=' + sn);
                    S.warming.delete(sn);
                }
            })
            .catch(() => {
                if (tries > 0) {
                    setTimeout(() => verifyWarmup(sn, tries - 1), CONFIG.WARMUP_RETRY_MS);
                } else {
                    S.warming.delete(sn);
                }
            });
    }

    // ============================================================
    //  本集去廣告：25s 自動完成 → 進正片 (沿用首版核心)
    // ============================================================
    function finishAd(session) {
        if (!session || session.ended) return;
        session.ended = true;
        console.log('[動畫瘋] 滿 25 秒，主動終止廣告並載入正片');

        try {
            if (session.handlerInst && typeof session.handlerInst.destroy === 'function') {
                session.handlerInst.destroy();
            }
        } catch (e) {}

        const playerEl = (session.player && session.player.el) ? session.player.el() : D.querySelector(SEL.container);
        if (playerEl) {
            playerEl.classList.remove(SEL.adPlaying);
            playerEl.classList.remove(SEL.adPlayingGeneric);
        }
        const skipBtn = D.querySelector(SEL.skipBtn);
        if (skipBtn) skipBtn.remove();
        const video = D.querySelector(SEL.video);
        if (video) video.muted = false;
        if (session.player && typeof session.player.muted === 'function') {
            try { session.player.muted(false); } catch (e) {}
        }

        const base = S.cishuStart || session.startTime;
        const wait = Math.max(0, CONFIG.BACKEND_ELAPSED_MS - (Date.now() - base));
        setTimeout(() => {
            const endUrl = `/ajax/videoCastcishu.php?s=${session.adInfo.adSid}&sn=${session.videoSn}&ad=end`;
            fetch(endUrl)
                .then(() => { if (session.onComplete) session.onComplete(); })
                .catch(() => { if (session.onComplete) session.onComplete(); });
        }, wait);
    }

    function hookPlayer(player) {
        if (!player || player.__aniHooked) return;
        player.__aniHooked = true;

        // 攔截 adHandler：捕獲廣告生命週期與 onComplete
        const setupAd = (h) => {
            if (h && !h.__playHooked) {
                h.__playHooked = true;
                const op = h.play.bind(h);
                h.play = function (videoSn, adInfo, onComplete) {
                    S.currentSession = {
                        player, handlerInst: h, videoSn, adInfo, onComplete,
                        startTime: Date.now(), ended: false
                    };
                    return op(videoSn, adInfo, onComplete);
                };
            }
        };
        if (typeof player.adHandler === 'function') {
            const oa = player.adHandler.bind(player);
            player.adHandler = function () {
                const inst = oa.apply(this, arguments);
                setupAd(inst);
                return inst;
            };
            try { setupAd(player.adHandler()); } catch (e) {}
        }

        // 攔截 animeAd / nativeAd 插件：倒數鎖 25s、壓制 error/end 回退
        const hookPlugin = (name) => {
            if (typeof player[name] !== 'function') return;
            const op = player[name].bind(player);
            const wrap = (inst) => {
                if (inst && !inst.__ani25) {
                    inst.__ani25 = true;
                    const op2 = inst.play.bind(inst);
                    inst.play = function (options) {
                        if (options) {
                            options.skipTime = CONFIG.SKIP_SECONDS;
                            options.skipCountDown = CONFIG.SKIP_SECONDS;
                        }
                        return op2(options);
                    };
                    const ot = inst.trigger.bind(inst);
                    inst.trigger = function (evt) {
                        const t = (typeof evt === 'string') ? evt : (evt && evt.type) || '';
                        if (t === 'error' || t === inst.AD_EVENTS?.ERROR) return; // 防止回退 Google Ads
                        if (t === 'end' || t === inst.AD_EVENTS?.END) {
                            finishAd(S.currentSession);
                            return;
                        }
                        return ot.apply(this, arguments);
                    };
                }
                return inst;
            };
            player[name] = function () { return wrap(op.apply(this, arguments)); };
            try { wrap(player[name]()); } catch (e) {}
        };
        hookPlugin('animeAd');
        hookPlugin('nativeAd');

        // 壓制廣告期間 player.error 彈窗
        const oe = player.error.bind(player);
        player.error = function (err) {
            if (err && S.currentSession && !S.currentSession.ended) return null;
            return oe.apply(this, arguments);
        };
    }

    function initPlayerHook() {
        const tryHook = () => {
            const vjs = W.videojs;
            let player = null;
            if (vjs && vjs.getPlayers) {
                const players = vjs.getPlayers();
                for (const k in players) { player = players[k]; break; }
            }
            if (player) {
                hookPlayer(player);
                startWarmupPolling();
                return;
            }
            setTimeout(tryHook, 300);
        };
        tryHook();
    }

    // 判斷當前是否仍在播廣告 (video 元素放的是廣告)
    function isAdPhase() {
        return Boolean(
            D.querySelector('.' + SEL.adPlaying) ||
            D.querySelector('.' + SEL.adPlayingGeneric) ||
            D.querySelector(SEL.vastBlocker) ||
            D.querySelector(SEL.skipBtn)
        );
    }

    // 片尾預熱輪詢：只在「正片、且確認為整集(>10分鐘)」時，剩8分鐘才觸發
    function startWarmupPolling() {
        if (S._pollingStarted) return;
        S._pollingStarted = true;
        let lastSn = getCurrentSn();
        setInterval(() => {
            // SPA 切集偵測：URL 的 sn 變了就重置本頁狀態（相容播放器「下一集」按鈕若走 history.pushState）
            const cur = getCurrentSn();
            if (cur !== null && cur !== lastSn) {
                lastSn = cur;
                S.warmupStarted = false;
                S.warming.clear();
                S.currentSession = null;
                S.cishuStart = 0;
                console.log('[動畫瘋] 偵測到切集 sn=' + cur + '，重置預熱狀態');
            }

            const video = D.querySelector(SEL.video);
            if (!video) return;

            // 1. 靜音策略：廣告期間靜音，正片解除
            video.muted = isAdPhase();

            // 2. 片尾觸發預熱（關鍵守衛見下）
            if (S.warmupStarted) return;   // 已觸發過，不再判斷
            if (isAdPhase()) return;        // 廣告階段：duration 只有~30s，會誤判，直接跳過
            if (!S.deviceId) return;        // 還沒拿到 deviceid

            const dur = video.duration;
            if (!dur || !isFinite(dur) || dur <= 0) return;
            if (dur <= 600) return;         // 太短的不是整集正片 (廣告/預告/短片)，跳過

            const remain = dur - video.currentTime;
            if (remain <= CONFIG.WARMUP_TRIGGER_REMAIN_SEC) {
                maybeStartWarmup();
            }
        }, 500);
    }

    // domWatcher：跳過按鈕一出現就自動點擊 (雙保險)
    function initDomWatcher() {
        const clickSkip = () => {
            const b = D.querySelector(SEL.skipBtn);
            if (b) { try { b.click(); } catch (e) {} }
        };
        const mo = new MutationObserver(() => {
            if (D.querySelector(SEL.skipBtn)) clickSkip();
        });
        const start = () => {
            if (D.body) mo.observe(D.body, { childList: true, subtree: true });
            else setTimeout(start, 200);
        };
        start();
    }

    // ---- 啟動 ----
    function boot() {
        initDomWatcher();
        initPlayerHook();
        console.log('[動畫瘋] 去廣告 + 下一集預熱腳本已載入 v2.2.0');
    }
    boot();
})();
