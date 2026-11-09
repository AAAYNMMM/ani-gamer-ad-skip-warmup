// ==UserScript==
// @name         巴哈動畫瘋 廣告跳過 + 下一集預熱
// @namespace    https://ani.gamer.com.tw/
// @version      2.9.0
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
        WARMUP_TRIGGER_REMAIN_SEC: 480, // 正片剩餘播放秒數達此門檻時觸發預熱 (8 分鐘)
        MIN_EPISODE_SEC: 600          // 判定為「整集正片」的最短時長 (10 分鐘)
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
        _pollingStarted: false, // 輪詢是否已啟動 (防重複)
        armed: true             // 首頁載入即視為已武裝；SPA 切集後需等新集 currentTime 回到開頭才重新武裝
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

    // 從頁面解析全部劇集 (優先 section.season 列表，缺省則掃全頁 animeVideo 連結)
    function getEpisodeList() {
        const out = [];
        const seen = new Set();
        const push = (sn) => { if (!seen.has(sn)) { seen.add(sn); out.push(sn); } };

        D.querySelectorAll('section.season a[href]').forEach(a => {
            const m = (a.getAttribute('href') || '').match(/[?&]sn=(\d+)/);
            if (m) push(parseInt(m[1], 10));
        });

        if (out.length === 0) {
            D.querySelectorAll('a[href*="animeVideo.php"]').forEach(a => {
                const m = (a.getAttribute('href') || '').match(/[?&]sn=(\d+)/);
                if (m) push(parseInt(m[1], 10));
            });
        }
        return out;
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

    // 取得正片總時長（相容 duration 為 Infinity 的 HLS 串流）
    function getDuration(video) {
        let d = video.duration;
        if (isFinite(d) && d > 0) return d;
        try {
            if (video.seekable && video.seekable.length > 0) {
                const end = video.seekable.end(video.seekable.length - 1);
                if (isFinite(end) && end > 0) return end;
            }
        } catch (e) {}
        // videojs player 的 duration() 更可靠
        try {
            const vjs = W.videojs;
            if (vjs && vjs.getPlayers) {
                const players = vjs.getPlayers();
                for (const k in players) {
                    const p = players[k];
                    if (p && typeof p.duration === 'function') {
                        const pd = p.duration();
                        if (isFinite(pd) && pd > 0) return pd;
                    }
                }
            }
        } catch (e) {}
        return NaN;
    }

    // ---- deviceid 捕獲 (保證與播放器一致) ----
    function setDevice(id) {
        if (!id || S.deviceId === id) return;
        S.deviceId = id;
        console.log('[動畫瘋] ✔ 捕獲 deviceid:', id);
        checkWarmupTrigger();
    }
    function captureDeviceFromUrl(url) {
        if (typeof url !== 'string') return;
        if (url.includes('token.php') && url.includes('device=')) {
            const m = url.match(/[?&]device=([^&]+)/);
            if (m) setDevice(decodeURIComponent(m[1]));
        }
    }
    function handleUrl(url) {
        if (typeof url !== 'string') return;
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
        if (S.warmupStarted) return;
        if (!S.deviceId) { console.log('[動畫瘋] 尚未捕獲 deviceid，暫不預熱'); return; }
        if (!domReady()) return;

        const next = getNextSn();
        if (next == null) {
            console.log('[動畫瘋] 無下一集可預熱（劇集列表: ' + JSON.stringify(getEpisodeList()) + '，當前 sn=' + getCurrentSn() + '）');
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

    // ---- 設備鎖管理（AniGamerPlus 的 unlock/checklock 流程，解決「同時間僅能播放一部影片」）----
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function unlockSn(sn) {
        return fetch(`/ajax/unlock.php?sn=${sn}&ttl=0`, { credentials: 'include' })
            .then(r => {
                console.log('[動畫瘋] 🔓 unlock sn=' + sn + ' → HTTP ' + r.status);
                return r;
            })
            .catch(e => {
                console.warn('[動畫瘋] ⚠ unlock sn=' + sn + ' 請求失敗:', e);
            });
    }
    function checkLockSn(sn) {
        return fetch(`/ajax/checklock.php?device=${S.deviceId}&sn=${sn}`, { credentials: 'include' })
            .then(r => r.text())
            .then(t => {
                console.log('[動畫瘋] 🔍 checklock sn=' + sn + ' →', t);
                return t;
            })
            .catch(e => {
                console.warn('[動畫瘋] ⚠ checklock sn=' + sn + ' 請求失敗:', e);
            });
    }
    function fetchText(url) {
        return fetch(url, { credentials: 'include' })
            .then(r => r.text())
            .catch(e => 'ERR:' + e);
    }
    function hasLockError(text) {
        return typeof text === 'string' && text.indexOf('僅提供播放一部影片') !== -1;
    }
    function checkToken(sn) {
        return fetch(`/ajax/token.php?sn=${sn}&device=${S.deviceId}&hash=${randStr(12)}`, { credentials: 'include' })
            .then(r => r.json())
            .then(j => !!(j && j.time === 1))
            .catch(() => false);
    }

    async function runWarmupFlow(sn) {
        try {
            // 0. 清設備鎖（unlock → checklock → unlock ×2）
            console.log('[動畫瘋] 開始清設備鎖，準備預熱 sn=' + sn);
            await unlockSn(sn);
            await checkLockSn(sn);
            await unlockSn(sn);
            await unlockSn(sn);

            // 1. 開始廣告計時
            const r1 = await fetchText(`/ajax/videoCastcishu.php?sn=${sn}&s=${CONFIG.AD_SLOT}`);
            if (hasLockError(r1)) console.warn('[動畫瘋] ⚠ 廣告計時遭遇設備鎖衝突');
            console.log('[動畫瘋] sn=' + sn + ' 廣告計時已開始，等待 ' + (CONFIG.WARMUP_WAIT_MS / 1000) + 's');

            // 2. 等滿 25s 門檻（26s 保險）
            await sleep(CONFIG.WARMUP_WAIT_MS);

            // 3. 結束廣告
            const r2 = await fetchText(`/ajax/videoCastcishu.php?sn=${sn}&s=${CONFIG.AD_SLOT}&ad=end`);
            if (hasLockError(r2)) console.warn('[動畫瘋] ⚠ ad=end 遭遇設備鎖衝突');

            // 4. 先只查 token；若已 time==1，就不必調 videoStart（避免搶佔設備鎖、干擾當前播放）
            let ok = await checkToken(sn);
            if (!ok) {
                // 5. 仍需要 videoStart 才計數
                const r3 = await fetchText(`/ajax/videoStart.php?sn=${sn}`);
                if (hasLockError(r3)) console.warn('[動畫瘋] ⚠ videoStart 遭遇設備鎖衝突（可能干擾當前集播放）');
                // 6. 重試查 token
                for (let i = 0; i < CONFIG.WARMUP_RETRY; i++) {
                    if (await checkToken(sn)) { ok = true; break; }
                    await sleep(CONFIG.WARMUP_RETRY_MS);
                }
            }

            if (ok) {
                console.log('[動畫瘋] ✔ 預熱成功！下一集 sn=' + sn + ' 已無廣告');
            } else {
                console.warn('[動畫瘋] ✘ 預熱失敗 sn=' + sn + '（token 未返回 time==1）');
            }
        } catch (e) {
            console.warn('[動畫瘋] 預熱流程異常:', e);
        } finally {
            // 7. 無論成敗都釋放下一集鎖，讓設備回到當前集，避免「同時間僅能播放一部影片」
            await unlockSn(sn);
            S.warming.delete(sn);
        }
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
        console.log('[動畫瘋] 廣告已滿 25 秒，' + wait + 'ms 後發送 &ad=end 並載入正片');
        setTimeout(() => {
            const endUrl = `/ajax/videoCastcishu.php?s=${session.adInfo.adSid}&sn=${session.videoSn}&ad=end`;
            fetch(endUrl)
                .then(() => {
                    console.log('[動畫瘋] ✔ 廣告跳過成功，已載入正片');
                    if (session.onComplete) session.onComplete();
                })
                .catch(() => {
                    console.warn('[動畫瘋] ⚠ 後端 &ad=end 請求失敗，仍嘗試載入正片');
                    if (session.onComplete) session.onComplete();
                });
        }, wait);
    }

    function hookPlayer(player) {
        if (!player || player.__aniHooked) return;
        player.__aniHooked = true;

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
                        if (t === 'error' || t === inst.AD_EVENTS?.ERROR) return;
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
                return;
            }
            setTimeout(tryHook, 300);
        };
        tryHook();
    }

    // ============================================================
    //  片尾預熱觸發（獨立於播放器掛鉤，避免依賴 videojs 初始化）
    // ============================================================
    function isAdPhase() {
        return Boolean(
            D.querySelector('.' + SEL.adPlaying) ||
            D.querySelector('.' + SEL.adPlayingGeneric) ||
            D.querySelector(SEL.vastBlocker) ||
            D.querySelector(SEL.skipBtn)
        );
    }

    function checkWarmupTrigger() {
        if (S.warmupStarted) return;
        if (!S.deviceId) return;

        const video = D.querySelector(SEL.video);
        if (!video) return;

        // 切集後必須先確認 video 已切到「本集」的時間軸（currentTime 回到開頭），
        // 否則會拿上一集殘留的 currentTime 誤判成片尾，在新集片頭就觸發預熱。
        if (!S.armed) {
            if (video.currentTime < 60) {
                S.armed = true;
                console.log('[動畫瘋] 已確認新集載入（currentTime=' + Math.floor(video.currentTime) + 's），開始監測播放進度');
            } else {
                return;
            }
        }

        const dur = getDuration(video);
        if (!isFinite(dur) || dur <= 0) return;
        if (dur <= CONFIG.MIN_EPISODE_SEC) return;

        const remain = dur - video.currentTime;
        if (remain <= CONFIG.WARMUP_TRIGGER_REMAIN_SEC) {
            console.log('[動畫瘋] 正片剩 ' + Math.floor(remain) + ' 秒（≤8分鐘），觸發下一集預熱');
            maybeStartWarmup();
        }
    }

    function startWarmupPolling() {
        if (S._pollingStarted) return;
        S._pollingStarted = true;
        console.log('[動畫瘋] 預熱輪詢已啟動（獨立於播放器）');

        let lastSn = getCurrentSn();

        setInterval(() => {
            // SPA 切集偵測
            const cur = getCurrentSn();
            if (cur !== null && cur !== lastSn) {
                lastSn = cur;
                S.warmupStarted = false;
                S.armed = false;          // ← 切集後重新武裝，等新集 currentTime 回到開頭
                S.warming.clear();
                S.currentSession = null;
                S.cishuStart = 0;
                console.log('[動畫瘋] 偵測到切集 sn=' + cur + '，重置預熱狀態');
            }

            const video = D.querySelector(SEL.video);
            if (video) {
                // 靜音策略：廣告期間靜音，正片解除
                video.muted = isAdPhase();
                // 片尾觸發預熱
                checkWarmupTrigger();
            }
        }, 500);

        // 拖動進度條後立即檢查
        const attachSeek = () => {
            const video = D.querySelector(SEL.video);
            if (!video) { setTimeout(attachSeek, 300); return; }
            video.addEventListener('seeked', checkWarmupTrigger);
            video.addEventListener('timeupdate', checkWarmupTrigger);
            // SPA 切集後，新集 metadata 載入且 currentTime 已回到開頭 → 重新武裝
            video.addEventListener('loadedmetadata', () => {
                if (!S.armed && video.currentTime < 60) {
                    S.armed = true;
                    console.log('[動畫瘋] 新集 metadata 已載入，重新武裝預熱判斷');
                }
            });
        };
        attachSeek();
    }

    // 年齡確認自動點擊：按文本匹配（不依賴易變的 class/id），排除「未滿18歲」
    function initAgeGuard() {
        // 匹配「已滿18」「我已滿18歲」「確認成年」等；不含「未滿」
        const HIT = [/我已滿\s*18/, /已滿\s*18\s*歲/, /滿\s*18\s*歲/, /我已成年/, /確認.*成年/, /我同意.*18/];
        const MISS = /未滿|不滿/;

        let lastClick = 0;
        const tryClick = () => {
            const now = Date.now();
            if (now - lastClick < 800) return; // 節流，避免 MutationObserver 頻繁觸發
            const cands = D.querySelectorAll('a, button, [role="button"], div, span');
            for (const el of cands) {
                const txt = (el.textContent || '').replace(/\s+/g, '');
                if (!txt || txt.length > 40) continue;          // 只看短文本元素（按鈕類）
                if (MISS.test(txt)) continue;                    // 排除「未滿18歲」
                if (HIT.some(re => re.test(txt))) {
                    // 優先點最內層可點擊元素
                    const target = el.closest('a, button, [role="button"]') || el;
                    try {
                        target.click();
                        lastClick = now;
                        console.log('[動畫瘋] ✔ 已自動點擊年齡確認：' + txt.slice(0, 20));
                    } catch (e) {}
                    return;
                }
            }
        };

        const mo = new MutationObserver(tryClick);
        const start = () => {
            if (D.body) mo.observe(D.body, { childList: true, subtree: true });
            else setTimeout(start, 200);
        };
        start();
        tryClick(); // 首次立即嘗試
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
        initAgeGuard();
        initPlayerHook();
        startWarmupPolling(); // 預熱輪詢獨立啟動，不依賴 videojs
        console.log('[動畫瘋] 去廣告 + 下一集預熱腳本已載入 v2.9.0');
    }
    boot();
})();
