// ==UserScript==
// @name         巴哈動畫瘋 廣告跳過 + 下一集預熱 (Bahamut Ani-Gamer Ad Skipper)
// @name:en      Bahamut Ani-Gamer Ad Skipper + Next Episode Pre-warm
// @name:zh-TW   巴哈動畫瘋 廣告跳過 + 下一集預熱
// @name:zh-CN   巴哈动画疯 广告跳过 + 下一集预热
// @namespace    https://github.com/AAAYNMMM/ani-gamer-ad-skip-warmup
// @version      3.5.0
// @description  動畫瘋去廣告：本集25秒自動跳過(靜音)、自動隱藏年齡分級遮罩，並在片尾無鎖干擾預熱下一集，連播無廣告。不誤觸付費頁。
// @description:en  Bahamut Ani-Gamer (ani.gamer.com.tw) ad skipper: auto-skip the 25s ad (muted), auto-dismiss the age-rating overlay, and pre-warm the next episode without device-lock interference. Never opens the paid page.
// @description:zh-CN 动画疯去广告：本集25秒自动跳过(静音)、自动隐藏年龄分级遮罩，并在片尾无锁干扰预热下一集，连播无广告。不会误触付费页。
// @author       AAAYNMMM
// @homepageURL  https://github.com/AAAYNMMM/ani-gamer-ad-skip-warmup
// @supportURL   https://github.com/AAAYNMMM/ani-gamer-ad-skip-warmup/issues
// @license      MIT
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
        SKIP_SECONDS: 25,               // 本集廣告自動完成秒數
        BACKEND_ELAPSED_MS: 25300,      // 本集後端驗證安全門檻 (>=25s)
        WARMUP_WAIT_MS: 26000,          // 預熱等待秒數 (略高於25s保險)
        AD_SLOT: '194699',              // 廣告調度 ID 兜底值
        WARMUP_RETRY: 6,                // 預熱 token 驗證重試次數
        WARMUP_RETRY_MS: 1500,          // 預熱 token 驗證重試間隔
        WARMUP_TRIGGER_REMAIN_SEC: 480, // 正片剩餘播放秒數達此門檻時觸發預熱 (8 分鐘)
        MIN_EPISODE_SEC: 600            // 判定為「整集正片」的最短時長 (10 分鐘)
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
        lastAdSid: null,       // 頁面真實使用的廣告調度 adSid
        cishuStart: 0,         // 本集廣告計時起點 (毫秒)
        currentSession: null,  // 本集廣告生命週期
        warming: new Set(),    // 正在預熱中的 sn (頁面內防重複)
        warmupStarted: false,  // 本頁是否已觸發過預熱
        _pollingStarted: false,// 輪詢是否已啟動 (防重複)
        armed: true,           // 首頁載入即視為已武裝；SPA 切集後需等新集 currentTime 回到開頭才重新武裝
        autoMuted: false,      // 是否由腳本自動靜音（尊重用戶手動靜音）
        lockBusy: false,       // 預熱是否正在操作設備鎖（期間暫緩 elapse 心跳防撞鎖）
        sessionEpoch: 0        // 切集計數器（切集時中止舊集未完成的預熱流程）
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
        if (url.includes('/ajax/videoCastcishu.php')) {
            const sm = url.match(/[?&]s=([^&]+)/);
            if (sm && sm[1]) S.lastAdSid = decodeURIComponent(sm[1]);
            if (!url.includes('ad=end')) {
                const m = url.match(/[?&]sn=(\d+)/);
                if (m && parseInt(m[1], 10) === getCurrentSn()) {
                    S.cishuStart = Date.now();
                }
            }
        }
        captureDeviceFromUrl(url);
    }

    // 取得真實可用的廣告調度 ID (優先使用頁面當前廣告調度，回退固定值)
    function getAdSlot() {
        if (S.lastAdSid) return S.lastAdSid;
        try {
            if (typeof W.getAd === 'function') {
                const ad = W.getAd();
                if (ad && ad[2]) return String(ad[2]);
            }
            if (typeof W.getMajorAd === 'function') {
                const ad = W.getMajorAd();
                if (ad && ad[2]) return String(ad[2]);
            }
        } catch (e) {}
        return CONFIG.AD_SLOT;
    }

    // ---- 網路攔截：fetch ----
    const origFetch = W.fetch.bind(W);

    // 將設備鎖交還給當前正在觀看的正片（避免後台預熱觸鎖後，當前集 elapse.php 回傳 state=4 殺死播放器）
    async function restoreCurrentLock(curSn) {
        const target = curSn || getCurrentSn();
        if (!target || !S.deviceId) return;
        try {
            await origFetch(`/ajax/checklock.php?device=${S.deviceId}&sn=${target}`, { credentials: 'include' });
            await origFetch(`/ajax/checklock.php?sn=${target}`, { credentials: 'include' });
            console.log('[動畫瘋] 🔒 已將設備鎖交還當前集 sn=' + target);
        } catch (e) {}
    }

    function makeOkElapseResponse(fallbackDevice) {
        return new Response(JSON.stringify({ state: 'ok', device: S.deviceId || fallbackDevice || '' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    W.fetch = function (resource, init) {
        let url = '';
        try {
            url = typeof resource === 'string' ? resource : (resource && resource.url) || '';
        } catch (e) {}
        handleUrl(url);

        // 防護 1：若預熱正在短暫操作設備鎖，暫緩當前集的 elapse.php 心跳，直接回傳 ok，防止撞鎖
        if (url.includes('/ajax/elapse.php') && S.lockBusy) {
            return Promise.resolve(makeOkElapseResponse());
        }

        const p = origFetch(resource, init);
        try {
            if (url.includes('/ajax/getdeviceid.php')) {
                p.then(r => r.clone().json()).then(j => {
                    if (j && j.deviceid) setDevice(j.deviceid);
                }).catch(() => {});
            }

            // 防護 2：攔截 elapse.php 響應；若後端因預熱或切集瞬態回傳 state=4（同時間僅能播放一部影片），
            // 自動在後台把鎖交還當前集並改寫為 state='ok'，防止官方播放器呼叫 animeMask().showError 銷毀播放器
            if (url.includes('/ajax/elapse.php')) {
                return p.then(async (resp) => {
                    try {
                        const data = await resp.clone().json();
                        if (data && data.state && data.state !== 'ok' && data.state !== 1) {
                            console.warn('[動畫瘋] 🛡 攔截到 elapse.php 設備鎖異常 (state=' + data.state + ')，自動恢復當前集設備鎖並保持播放');
                            const cur = getCurrentSn();
                            if (cur) {
                                origFetch(`/ajax/unlock.php?sn=${cur}&ttl=0`, { credentials: 'include' })
                                    .then(() => restoreCurrentLock(cur))
                                    .catch(() => {});
                            }
                            return makeOkElapseResponse(data.device);
                        }
                    } catch (e) {}
                    return resp;
                });
            }

            // 防護 3：切集載入 video_src.php 時若因上一集鎖尚未釋放而報錯，自動解鎖並重試一次
            if (url.includes('/anime/v1/video_src.php')) {
                return p.then(async (resp) => {
                    try {
                        const data = await resp.clone().json();
                        if (data && data.error) {
                            const cur = getCurrentSn();
                            console.warn('[動畫瘋] 🛡 video_src.php 遭遇鎖衝突，自動釋放設備鎖並重試:', data.error);
                            if (cur) {
                                await origFetch(`/ajax/unlock.php?sn=${cur}&ttl=0`, { credentials: 'include' }).catch(() => {});
                                if (S.deviceId) {
                                    await origFetch(`/ajax/checklock.php?device=${S.deviceId}&sn=${cur}`, { credentials: 'include' }).catch(() => {});
                                }
                                await origFetch(`/ajax/unlock.php?sn=${cur}&ttl=0`, { credentials: 'include' }).catch(() => {});
                            }
                            return origFetch(resource, init);
                        }
                    } catch (e) {}
                    return resp;
                });
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
    //  預熱核心：後台替下一集過廣告（無鎖干擾設計）
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
        warmup(next, S.sessionEpoch);
    }

    function warmup(sn, epoch) {
        if (!S.deviceId || S.warming.has(sn)) return;
        S.warming.add(sn);
        console.log('[動畫瘋] 開始後台預熱下一集 sn=' + sn);

        origFetch(`/ajax/token.php?sn=${sn}&device=${S.deviceId}&hash=${randStr(12)}`, { credentials: 'include' })
            .then(r => r.json())
            .then(j => {
                if (S.sessionEpoch !== epoch || getCurrentSn() === sn) {
                    S.warming.delete(sn);
                    return;
                }
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
                runWarmupFlow(sn, epoch);
            })
            .catch(() => runWarmupFlow(sn, epoch));
    }

    // ---- 設備鎖與請求工具 ----
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function unlockSn(sn, keepalive = false) {
        if (!sn) return Promise.resolve();
        return origFetch(`/ajax/unlock.php?sn=${sn}&ttl=0`, { credentials: 'include', keepalive })
            .then(r => {
                console.log('[動畫瘋] 🔓 unlock sn=' + sn + ' → HTTP ' + r.status);
                return r;
            })
            .catch(e => {
                console.warn('[動畫瘋] ⚠ unlock sn=' + sn + ' 請求失敗:', e);
            });
    }
    function fetchText(url) {
        return origFetch(url, { credentials: 'include' })
            .then(r => r.text())
            .catch(e => 'ERR:' + e);
    }
    function hasLockError(text) {
        return typeof text === 'string' && /僅提供播放一部影片|僅限一台裝置|僅允許一個裝置/.test(text);
    }
    function checkToken(sn) {
        return origFetch(`/ajax/token.php?sn=${sn}&device=${S.deviceId}&hash=${randStr(12)}`, { credentials: 'include' })
            .then(r => r.json())
            .then(j => !!(j && j.time === 1))
            .catch(() => false);
    }

    // 僅在後端返回鎖衝突時，才短暫釋放當前集與目標集鎖
    async function releaseActiveLocks(curSn, nextSn) {
        S.lockBusy = true;
        if (curSn && curSn !== nextSn) await unlockSn(curSn);
        await unlockSn(nextSn);
    }

    async function runWarmupFlow(sn, epoch) {
        const isStale = () => S.sessionEpoch !== epoch || getCurrentSn() === sn;
        let lockTouched = false;
        const adSlot = getAdSlot();

        try {
            if (isStale()) return;

            // 1. 直接開始廣告計時（不預先調用 checklock.php / videoStart.php，避免搶奪當前集播放鎖）
            let r1 = await fetchText(`/ajax/videoCastcishu.php?sn=${sn}&s=${adSlot}`);
            if (isStale()) return;
            if (hasLockError(r1)) {
                console.warn('[動畫瘋] ⚠ 廣告計時遭遇設備鎖衝突，短暫釋放當前集鎖後重試');
                lockTouched = true;
                await releaseActiveLocks(getCurrentSn(), sn);
                r1 = await fetchText(`/ajax/videoCastcishu.php?sn=${sn}&s=${adSlot}`);
                // 若在等待 26 秒期間曾釋放過鎖，立即先還鎖給當前集，避免等待期間 elapse 心跳失鎖
                await restoreCurrentLock(getCurrentSn());
                S.lockBusy = false;
            }
            console.log('[動畫瘋] sn=' + sn + ' 廣告計時已開始 (s=' + adSlot + ')，等待 ' + (CONFIG.WARMUP_WAIT_MS / 1000) + 's');

            // 2. 等滿 25s 門檻（26s 保險）
            await sleep(CONFIG.WARMUP_WAIT_MS);
            if (isStale()) return;

            // 3. 結束廣告
            let r2 = await fetchText(`/ajax/videoCastcishu.php?sn=${sn}&s=${adSlot}&ad=end`);
            if (isStale()) return;
            if (hasLockError(r2)) {
                console.warn('[動畫瘋] ⚠ ad=end 遭遇設備鎖衝突，短暫釋放當前集鎖後重試');
                lockTouched = true;
                await releaseActiveLocks(getCurrentSn(), sn);
                r2 = await fetchText(`/ajax/videoCastcishu.php?sn=${sn}&s=${adSlot}&ad=end`);
            }

            // 4. 優先只靠廣告計數驗證 token（不碰 checklock / videoStart，零鎖干擾）
            let ok = false;
            for (let i = 0; i < 3; i++) {
                if (isStale()) return;
                if (await checkToken(sn)) { ok = true; break; }
                await sleep(1000);
                if (isStale()) return;
                await fetchText(`/ajax/videoCastcishu.php?sn=${sn}&s=${adSlot}&ad=end`);
            }

            // 5. 僅當純廣告計數仍未讓 token 變成 time==1 時，才短暫借鎖執行 videoStart 並立即歸還
            if (!ok && !isStale()) {
                lockTouched = true;
                await releaseActiveLocks(getCurrentSn(), sn);
                const r3 = await fetchText(`/ajax/videoStart.php?sn=${sn}`);
                if (hasLockError(r3)) console.warn('[動畫瘋] ⚠ videoStart 遭遇設備鎖衝突');
                for (let i = 0; i < CONFIG.WARMUP_RETRY; i++) {
                    if (isStale()) break;
                    if (await checkToken(sn)) { ok = true; break; }
                    await sleep(CONFIG.WARMUP_RETRY_MS);
                }
            }

            if (ok) {
                console.log('[動畫瘋] ✔ 預熱成功！下一集 sn=' + sn + ' 已無廣告');
            } else if (!isStale()) {
                console.warn('[動畫瘋] ✘ 預熱失敗 sn=' + sn + '（token 未返回 time==1）');
            }
        } catch (e) {
            console.warn('[動畫瘋] 預熱流程異常:', e);
        } finally {
            // 6. 若預熱期間曾觸碰過設備鎖，且用戶仍在觀看原本那集，則釋放下一集鎖並將鎖交還當前集
            if (lockTouched) {
                const cur = getCurrentSn();
                if (cur !== sn) {
                    await unlockSn(sn);
                    if (cur) await restoreCurrentLock(cur);
                }
            }
            S.lockBusy = false;
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
        if (video && S.autoMuted) {
            video.muted = false;
            S.autoMuted = false;
        }
        if (session.player && typeof session.player.muted === 'function' && S.autoMuted) {
            try { session.player.muted(false); } catch (e) {}
        }

        const base = S.cishuStart || session.startTime;
        const wait = Math.max(0, CONFIG.BACKEND_ELAPSED_MS - (Date.now() - base));
        console.log('[動畫瘋] 廣告已滿 25 秒，' + wait + 'ms 後發送 &ad=end 並載入正片');
        setTimeout(() => {
            const endUrl = `/ajax/videoCastcishu.php?s=${session.adInfo.adSid}&sn=${session.videoSn}&ad=end`;
            origFetch(endUrl, { credentials: 'include' })
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
                    if (adInfo && adInfo.adSid) S.lastAdSid = String(adInfo.adSid);
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

        // 攔截 animeMask().showError：防止設備鎖異常提示觸發 this.player.dispose() 銷毀播放器
        const setupMask = (m) => {
            if (m && !m.__maskHooked && typeof m.showError === 'function') {
                m.__maskHooked = true;
                const origShowError = m.showError.bind(m);
                m.showError = function (msg) {
                    if (typeof msg === 'string' && /僅提供播放一部影片|僅限一台裝置|僅允許一個裝置/.test(msg)) {
                        console.warn('[動畫瘋] 🛡 已攔截播放器設備鎖錯誤遮罩，自動恢復設備鎖:', msg);
                        const cur = getCurrentSn();
                        if (cur) {
                            unlockSn(cur).then(() => restoreCurrentLock(cur));
                        }
                        return;
                    }
                    return origShowError(msg);
                };
            }
        };
        if (typeof player.animeMask === 'function') {
            const om = player.animeMask.bind(player);
            player.animeMask = function () {
                const inst = om.apply(this, arguments);
                setupMask(inst);
                return inst;
            };
            try { setupMask(player.animeMask()); } catch (e) {}
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
            const errMsg = (typeof err === 'string') ? err : (err && err.message) || '';
            if (/僅提供播放一部影片|僅限一台裝置|僅允許一個裝置|Duplicate login/i.test(errMsg)) {
                console.warn('[動畫瘋] 🛡 已攔截 player.error 設備鎖衝突:', errMsg);
                const cur = getCurrentSn();
                if (cur) unlockSn(cur).then(() => restoreCurrentLock(cur));
                return null;
            }
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

    // 頁面卸載或跳轉下一集時自動釋放當前集設備鎖（防止預熱後 0 秒進下一集時上一集鎖未退）
    function initUnloadUnlock() {
        let released = false;
        const releaseCurrent = () => {
            if (released) return;
            const cur = getCurrentSn();
            if (!cur) return;
            released = true;
            S.sessionEpoch++;
            unlockSn(cur, true);
        };
        W.addEventListener('pagehide', releaseCurrent);
        W.addEventListener('beforeunload', releaseCurrent);
    }

    // ============================================================
    //  片尾預熱觸發（獨立於播放器掛鉤，避免依賴 videojs 初始化）
    // ============================================================
    // 是否廣告中：使用播放器權威生命週期類名 vjs-*-ad-playing 判斷（避免跳過按鈕殘留導致正片被誤靜音）
    function isAdPhase() {
        const els = D.querySelectorAll('#ani_video, .video-js, [class*="ad-playing"]');
        for (const el of els) {
            const cls = el.getAttribute('class') || '';
            if (/(^|\s)vjs-[a-z0-9-]*ad-playing(\s|$)/.test(cls)) return true;
        }
        return false;
    }

    function checkWarmupTrigger() {
        if (S.warmupStarted) return;
        if (isAdPhase()) return;
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
                const prevSn = lastSn;
                lastSn = cur;
                S.sessionEpoch++;         // ← 中止舊集仍在進行中的異步預熱流程
                S.lockBusy = false;
                S.warmupStarted = false;
                S.armed = false;          // ← 切集後重新武裝，等新集 currentTime 回到開頭
                S.warming.clear();
                S.currentSession = null;
                S.cishuStart = 0;
                if (prevSn && prevSn !== cur) {
                    unlockSn(prevSn);     // ← 立即釋放上一集設備鎖，避免新集無廣告秒進時撞鎖
                }
                console.log('[動畫瘋] 偵測到切集 sn=' + cur + '，已釋放上一集設備鎖並重置預熱狀態');
            }

            const video = D.querySelector(SEL.video);
            if (video) {
                // 靜音策略：僅在廣告期間自動靜音，正片僅恢復腳本自動靜的音（尊重用戶手動靜音）
                if (isAdPhase()) {
                    if (!video.muted) {
                        video.muted = true;
                        S.autoMuted = true;
                    }
                } else if (S.autoMuted) {
                    if (video.muted) video.muted = false;
                    S.autoMuted = false;
                }
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

    // 年齡分級確認：直接隱藏整個遮罩彈窗（連提示都不顯示），並自動點確認放行播放
    // 兼容 12/15/18 等各種分級，不再寫死 18 歲
    function initAgeGuard() {
        const HIT = [
            /我已滿\s*\d{1,2}\s*歲/,      // 我已滿18歲 / 我已滿12歲
            /已滿\s*\d{1,2}\s*歲/,         // 已滿15歲
            /年滿\s*\d{1,2}\s*歲/,         // 年滿18歲
            /滿\s*\d{1,2}\s*歲以上/,       // 滿18歲以上
            /我已成年/,                    // 我已成年
            /我已年滿/,                    // 我已年滿
            /確認.*成年/,                  // 確認已成年
            /我.*已滿.*歲/                 // 兜底
        ];
        const MISS = /未滿|不滿/;         // 排除「未滿/不滿 X 歲」

        // 注入一條樣式：被標記的遮罩直接 display:none
        const styleEl = D.createElement('style');
        styleEl.textContent = '[data-ani-age-hidden="1"]{display:none!important;}';
        (D.head || D.documentElement).appendChild(styleEl);

        let lastAct = 0;

        // 從命中元素往上找「彈窗/遮罩容器」：優先 containing 的 position:fixed / 大面積容器
        function findOverlay(el) {
            let node = el;
            let best = null;
            for (let i = 0; i < 6 && node && node !== D.body; i++) {
                const cs = (node.currentStyle || W.getComputedStyle(node));
                if (cs && (cs.position === 'fixed' || cs.position === 'absolute')) {
                    best = node; // 記錄最外層 absolute/fixed 容器
                }
                // 面積很大、覆蓋全螢幕的也算遮罩
                if (node.clientWidth >= W.innerWidth * 0.6 && node.clientHeight >= W.innerHeight * 0.6) {
                    best = node;
                }
                node = node.parentElement;
            }
            return best || el.parentElement || el;
        }

        const run = () => {
            const now = Date.now();
            if (now - lastAct < 500) return;

            const isBtn = (el) => el.closest('a, button, [role="button"]');
            const clickEl = (btn) => { if (btn) { try { btn.click(); } catch (e) {} } };
            // 已處理過（已隱藏）的容器：跳過，避免一直重複處理同一個遮罩而卡住後面的
            const alreadyHidden = (el) => !!el.closest('[data-ani-age-hidden="1"]');

            // 第 0 層（最可靠）：動畫瘋真實分級彈窗結構
            // <div class="R18"><div class="video-cover-ncc"><div class="ncc-choosearea">...
            //   <button class="choose-btn-agree" id="adult">同意</button>
            //   <button class="choose-btn-disagree" id="not-adult">不同意</button>
            const realGate = D.querySelector('.video-cover-ncc, .ncc-choosearea, .R18 .ncc-choosebar');
            if (realGate && !alreadyHidden(realGate)) {
                lastAct = now;
                const cover = D.querySelector('.video-cover-ncc') || realGate;
                cover.setAttribute('data-ani-age-hidden', '1');
                const agree = D.getElementById('adult') || D.querySelector('.choose-btn-agree')
                    || Array.from(realGate.querySelectorAll('button')).find(b => /同意/.test(b.textContent || ''));
                if (agree) { try { agree.click(); } catch (e) {} }
                console.log('[動畫瘋] ✔ 已隱藏分級遮罩(.video-cover-ncc)並點「同意」');
                return;
            }

            // 第一層：按鈕/短文本直接命中「我已滿X歲 / 已成年」等
            const cands = D.querySelectorAll('a, button, [role="button"], div, span');
            for (const el of cands) {
                if (alreadyHidden(el)) continue;
                const txt = (el.textContent || '').replace(/\s+/g, '');
                if (!txt || txt.length > 40) continue;
                if (MISS.test(txt)) continue;
                if (HIT.some(re => re.test(txt))) {
                    lastAct = now;
                    const overlay = findOverlay(el);
                    if (overlay) {
                        overlay.setAttribute('data-ani-age-hidden', '1');
                        console.log('[動畫瘋] ✔ 已隱藏分級確認遮罩（命中：' + txt.slice(0, 16) + '）');
                    }
                    clickEl(isBtn(el) || el);
                    return;
                }
            }

            // 第二層：容器含「年齡/分級/歲」等語義 + 內有「我同意/確認/我了解」按鈕
            const containers = D.querySelectorAll('div');
            for (const box of containers) {
                if (alreadyHidden(box)) continue;
                const boxTxt = (box.textContent || '').replace(/\s+/g, '');
                if (boxTxt.length < 6 || boxTxt.length > 200) continue;
                if (MISS.test(boxTxt) && !HIT.some(re => re.test(boxTxt))) {
                    // 若整體含未滿又無正面確認文字，跳過
                    if (!/我已滿|已滿|年滿/.test(boxTxt)) continue;
                }
                if (!/(分級|年齡|歲|級別|保護級|輔導|限制級)/.test(boxTxt)) continue;
                // 找這個容器內的確認按鈕（且未被隱藏）
                const okBtn = Array.from(box.querySelectorAll('a, button, [role="button"], div, span'))
                    .find(b => {
                        if (alreadyHidden(b)) return false;
                        const t = (b.textContent || '').replace(/\s+/g, '');
                        return t && t.length <= 20 && /^(我同意|同意|確認|我了解|確定|繼續|我已滿|確認進入)/.test(t);
                    });
                if (okBtn) {
                    lastAct = now;
                    box.setAttribute('data-ani-age-hidden', '1');
                    console.log('[動畫瘋] ✔ 已隱藏分級確認遮罩（容器語義命中）');
                    clickEl(okBtn.closest('a, button, [role="button"]') || okBtn);
                    return;
                }
            }
        };

        const mo = new MutationObserver(run);
        const start = () => {
            if (D.body) mo.observe(D.body, { childList: true, subtree: true });
            else setTimeout(start, 200);
        };
        start();
        run();
    }

    // domWatcher：跳過按鈕「可跳過」時自動點擊（雙保險）
    // 重要：動畫瘋的 #adSkipButton 在倒數結束前被點擊，會 window.open 打開付費頁！
    // 只有倒數歸零、按鈕加上 .enable（或文字變成「點此跳過廣告」）後，點擊才是真跳過。
    function initDomWatcher() {
        const isSkipReady = (b) => {
            if (!b) return false;
            if (b.classList.contains('enable')) return true;
            const t = (b.textContent || '').replace(/\s+/g, '');
            // 倒數中是「剩餘 XX 秒」之類；只有出現「點此跳過廣告/跳過」才是可用狀態
            return /跳過廣告|點此跳過|skip/i.test(t) && !/\d+\s*秒/.test(t);
        };
        const clickSkip = () => {
            const b = D.querySelector(SEL.skipBtn);
            if (isSkipReady(b)) { try { b.click(); } catch (e) {} }
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
        initUnloadUnlock();
        startWarmupPolling(); // 預熱輪詢獨立啟動，不依賴 videojs
        console.log('[動畫瘋] 去廣告 + 下一集預熱腳本已載入 v3.5.0');
    }
    boot();
})();
