const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

const app = express();
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '32kb' }));
app.disable('x-powered-by');

axios.defaults.timeout = 15000;
axios.defaults.maxContentLength = 8 * 1024 * 1024;
axios.defaults.maxBodyLength = 2 * 1024 * 1024;

const BASE_URL = 'https://glb.servergi.com:8071/iSIMGLBMTR';
const LOGIN_URL = `${BASE_URL}/Login`;
const HOME_URL = `${BASE_URL}/home`;
const PROFILE_URL = `${BASE_URL}/Student/Course`;
const ATTENDANCE_URL = `${BASE_URL}/Student/TodayAttendence`;
const TIMETABLE_URL = `${BASE_URL}/Student/TimeTable`;
const EXAM_RESULT_URL = `${BASE_URL}/Student/ExamResult`;
const PORT = Number(process.env.PORT) || 3000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const KEEP_ALIVE_INTERVAL_MS = 100 * 1000;
const AWAKE_USERS = ['26CSAIM197'];
const sessions = new Map();
const keepAliveTimers = new Map();
const rateBuckets = new Map();

function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
        bucket = { startedAt: now, count: 0 };
        rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= limit;
}

function createSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

function stopSessionKeepAlive(sessionId) {
    const timer = keepAliveTimers.get(sessionId);
    if (timer) clearInterval(timer);
    keepAliveTimers.delete(sessionId);
}

function destroySession(sessionId) {
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (session) {
        session.closed = true;
        session.loggedIn = false;
        session.attFormHtml = null;
        session.attMode = null;
    }
    stopSessionKeepAlive(sessionId);
    sessions.delete(sessionId);
}

function invalidateSession(sessionId, session) {
    if (session) {
        session.closed = true;
        session.loggedIn = false;
        session.attFormHtml = null;
        session.attMode = null;
    }
    stopSessionKeepAlive(sessionId);
    if (!session || sessions.get(sessionId) === session) sessions.delete(sessionId);
}

function runSessionOperation(session, operation) {
    const previous = session.operationQueue || Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
        if (session.closed || !session.loggedIn) throw sessionExpiredError();
        return operation();
    });
    session.operationQueue = current.then(() => undefined, () => undefined);
    return current;
}

function startSessionKeepAlive(sessionId, session) {
    stopSessionKeepAlive(sessionId);
    if (!session.loggedIn || !AWAKE_USERS.includes(session.userId)) return;

    const timer = setInterval(() => {
        if (sessions.get(sessionId) !== session || !session.loggedIn) {
            stopSessionKeepAlive(sessionId);
            return;
        }
        if (session.keepAliveInFlight) return;
        session.keepAliveInFlight = true;

        runSessionOperation(session, async () => {
            const html = await fetchPortalHtml(session, HOME_URL, HOME_URL);
            if (isPortalLoginPage(html)) throw sessionExpiredError();
            session.lastSeenAt = Date.now();
            session.lastPortalCheckAt = Date.now();
        }).catch(error => {
            if (error.code === 'SESSION_EXPIRED') {
                invalidateSession(sessionId, session);
                console.warn(`[Session] Portal session expired for ${session.userId}; keep-alive stopped.`);
            } else {
                console.warn(`[Session] Keep-alive request failed for ${session.userId}: ${error.message}`);
            }
        }).finally(() => {
            session.keepAliveInFlight = false;
        });
    }, KEEP_ALIVE_INTERVAL_MS);
    timer.unref();
    keepAliveTimers.set(sessionId, timer);
}

function getSession(sessionId, requireLogin = true) {
    if (typeof sessionId !== 'string' || !/^[a-f0-9]{64}$/i.test(sessionId)) return null;
    const session = sessions.get(sessionId);
    if (!session || session.closed || Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
        destroySession(sessionId);
        return null;
    }
    if (requireLogin && !session.loggedIn) return null;
    session.lastSeenAt = Date.now();
    return session;
}

setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.lastSeenAt > SESSION_TTL_MS) destroySession(id);
    }
    for (const [key, bucket] of rateBuckets) {
        if (now - bucket.startedAt > 60 * 60 * 1000) rateBuckets.delete(key);
    }
}, 5 * 60 * 1000).unref();

function mergeCookies(oldCookies = '', newCookieHeaders = []) {
    const map = new Map();
    String(oldCookies).split(';').forEach(part => {
        const item = part.trim();
        if (!item) return;
        const index = item.indexOf('=');
        if (index > 0) map.set(item.slice(0, index), item.slice(index + 1));
    });
    for (const cookie of (newCookieHeaders || [])) {
        const first = String(cookie).split(';')[0];
        const index = first.indexOf('=');
        if (index > 0) map.set(first.slice(0, index).trim(), first.slice(index + 1).trim());
    }
    return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function formatDateForDotNet(dateStr) {
    if (!dateStr) return '';
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr;
    const [y, m, d] = dateStr.split('-');
    return `${d}/${m}/${y}`;
}

function cleanText(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function isPortalLoginPage(html) {
    if (typeof html !== 'string') return false;
    return /__txtUserId100|txtPass/.test(html);
}

function sessionExpiredError() {
    const error = new Error('College portal session expired');
    error.code = 'SESSION_EXPIRED';
    return error;
}

function extractFormPayload(html, buttonName, buttonValue, extraFields = {}) {
    const $page = cheerio.load(html);
    const form = $page('form').first();
    const payload = new URLSearchParams();

    form.find('input,select,textarea').each((_, el) => {
        const $el = $page(el);
        const name = $el.attr('name');
        if (!name || $el.is(':disabled')) return;
        const type = ($el.attr('type') || '').toLowerCase();
        if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) return;
        if ((type === 'checkbox' || type === 'radio') && !$el.is(':checked')) return;
        payload.append(name, $el.val() || '');
    });

    for (const [key, value] of Object.entries(extraFields)) payload.set(key, value);
    if (buttonName) payload.set(buttonName, buttonValue);
    return payload;
}

async function fetchAttendancePageHtml(session) {
    const res = await axios.get(ATTENDANCE_URL, {
        headers: { Cookie: session.cookies, Referer: HOME_URL, 'User-Agent': 'Mozilla/5.0' },
        validateStatus: status => status >= 200 && status < 400
    });
    session.cookies = mergeCookies(session.cookies, res.headers['set-cookie']);
    if (isPortalLoginPage(res.data)) throw sessionExpiredError();
    session.attFormHtml = res.data;
    session.attMode = null;
    return res.data;
}

async function executeAttendancePostback(session, buttonName, buttonValue, extraFields = {}) {
    if (!session.attFormHtml) {
        await fetchAttendancePageHtml(session);
    }

    try {
        const payload = extractFormPayload(session.attFormHtml, buttonName, buttonValue, extraFields);
        const postRes = await axios.post(ATTENDANCE_URL, payload.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: session.cookies,
                Referer: ATTENDANCE_URL,
                'User-Agent': 'Mozilla/5.0'
            },
            maxRedirects: 5,
            validateStatus: status => status >= 200 && status < 400
        });
        session.cookies = mergeCookies(session.cookies, postRes.headers['set-cookie']);
        if (isPortalLoginPage(postRes.data)) throw sessionExpiredError();

        if (typeof postRes.data === 'string' && postRes.data.includes('__VIEWSTATE')) {
            session.attFormHtml = postRes.data;
            return postRes.data;
        }
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') throw err;
    }

    const freshHtml = await fetchAttendancePageHtml(session);
    const retryPayload = extractFormPayload(freshHtml, buttonName, buttonValue, extraFields);
    const retryRes = await axios.post(ATTENDANCE_URL, retryPayload.toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: session.cookies,
            Referer: ATTENDANCE_URL,
            'User-Agent': 'Mozilla/5.0'
        },
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400
    });
    session.cookies = mergeCookies(session.cookies, retryRes.headers['set-cookie']);
    if (isPortalLoginPage(retryRes.data)) throw sessionExpiredError();
    if (typeof retryRes.data === 'string' && retryRes.data.includes('__VIEWSTATE')) {
        session.attFormHtml = retryRes.data;
    }
    return retryRes.data;
}


function portalHeaders(session, referer = HOME_URL) {
    return {
        Cookie: session.cookies,
        Referer: referer,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };
}

async function fetchPortalHtml(session, url, referer = HOME_URL) {
    const response = await axios.get(url, {
        headers: portalHeaders(session, referer),
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400
    });
    session.cookies = mergeCookies(session.cookies, response.headers['set-cookie']);
    if (isPortalLoginPage(response.data)) {
        invalidateSession(session.sessionId, session);
        throw sessionExpiredError();
    }
    if (typeof response.data !== 'string') throw new Error('Unexpected portal response format');
    return response.data;
}

function controlName($, selector, fallback) {
    const name = $(selector).first().attr('name');
    return name || fallback;
}

function extractDoPostBackTarget(onchange) {
    const value = String(onchange || '');
    const match = value.match(/__doPostBack\(['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]\)/i);
    return match ? { target: match[1], argument: match[2] } : null;
}

async function submitPortalForm(session, url, html, options = {}) {
    const $ = cheerio.load(html);
    const form = $('form').first();
    if (!form.length) throw new Error('Portal form was not found');

    const button = options.buttonSelector ? $(options.buttonSelector).first() : null;
    const buttonName = options.buttonName || (button && button.attr('name')) || '';
    const buttonValue = options.buttonValue !== undefined
        ? options.buttonValue
        : ((button && button.val()) || (button && button.text()) || '');
    const payload = extractFormPayload(html, buttonName, buttonValue, options.fields || {});

    if (options.eventTarget) payload.set('__EVENTTARGET', options.eventTarget);
    if (options.eventArgument !== undefined) payload.set('__EVENTARGUMENT', options.eventArgument);

    const action = form.attr('action');
    const actionUrl = action ? new URL(action, url).href : url;
    if (new URL(actionUrl).origin !== new URL(BASE_URL).origin) {
        throw new Error('Portal form returned an unexpected action URL');
    }

    const response = await axios.post(actionUrl, payload.toString(), {
        headers: {
            ...portalHeaders(session, url),
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': new URL(BASE_URL).origin
        },
        maxRedirects: 5,
        maxContentLength: 8 * 1024 * 1024,
        validateStatus: status => status >= 200 && status < 400
    });
    session.cookies = mergeCookies(session.cookies, response.headers['set-cookie']);
    if (isPortalLoginPage(response.data)) {
        invalidateSession(session.sessionId, session);
        throw sessionExpiredError();
    }
    if (typeof response.data !== 'string') throw new Error('Unexpected portal postback response');
    return response.data;
}

function parseSelectOptions($, selector) {
    const options = [];
    $(selector).first().find('option').each((_, element) => {
        const value = String($(element).attr('value') ?? cleanText($(element).text()));
        const label = cleanText($(element).text());
        if (!label || /^--select--$/i.test(label) || value === '--Select--') return;
        options.push({ value, label });
    });
    return options;
}

async function getTimetableByMode(session, mode) {
    const html = await fetchPortalHtml(session, TIMETABLE_URL, HOME_URL);
    const buttonId = mode === 'today' ? '#MCPH1_SCPH_Button2' : '#MCPH1_SCPH_Button1';
    const $ = cheerio.load(html);
    const button = $(buttonId).first();
    const fallbackName = mode === 'today'
        ? 'ctl00$ctl00$MCPH1$SCPH$Button2'
        : 'ctl00$ctl00$MCPH1$SCPH$Button1';
    const postbackHtml = await submitPortalForm(session, TIMETABLE_URL, html, {
        buttonSelector: buttonId,
        buttonName: button.attr('name') || fallbackName,
        buttonValue: button.val() || (mode === 'today' ? 'Today' : 'Weekly')
    });
    return { html: postbackHtml };
}

async function getResultOptions(session, selectedSemester = '') {
    const html = await fetchPortalHtml(session, EXAM_RESULT_URL, HOME_URL);
    const $ = cheerio.load(html);
    let resultHtml = html;
    const semesterSelector = '#MCPH1_SCPH_ddldrp';
    const examSelector = '#MCPH1_SCPH_ddlExamName';
    const semesterOptions = parseSelectOptions($, semesterSelector);
    let examOptions = parseSelectOptions($, examSelector);

    if (selectedSemester) {
        const select = $(semesterSelector).first();
        const selectName = select.attr('name') || 'ctl00$ctl00$MCPH1$SCPH$ddldrp';
        const onchange = select.attr('onchange') || '';
        const postback = extractDoPostBackTarget(onchange);
        if (postback) {
            resultHtml = await submitPortalForm(session, EXAM_RESULT_URL, html, {
                fields: { [selectName]: selectedSemester },
                eventTarget: postback.target,
                eventArgument: postback.argument
            });
            const $updated = cheerio.load(resultHtml);
            examOptions = parseSelectOptions($updated, examSelector);
        }
    }

    return { semesters: semesterOptions, exams: examOptions };
}

async function getExamResult(session, semester, exam) {
    if (typeof semester !== 'string' || !semester.trim() || semester.length > 40) {
        const error = new Error('Select a valid semester.');
        error.statusCode = 400;
        throw error;
    }
    if (typeof exam !== 'string' || !exam.trim() || exam.length > 80) {
        const error = new Error('Select a valid examination.');
        error.statusCode = 400;
        throw error;
    }

    let html = await fetchPortalHtml(session, EXAM_RESULT_URL, HOME_URL);
    let $ = cheerio.load(html);
    const semesterSelect = $('#MCPH1_SCPH_ddldrp').first();
    const semesterName = semesterSelect.attr('name') || 'ctl00$ctl00$MCPH1$SCPH$ddldrp';
    const semesterPostback = extractDoPostBackTarget(semesterSelect.attr('onchange') || '');
    if (semesterPostback) {
        html = await submitPortalForm(session, EXAM_RESULT_URL, html, {
            fields: { [semesterName]: semester },
            eventTarget: semesterPostback.target,
            eventArgument: semesterPostback.argument
        });
        $ = cheerio.load(html);
    }

    const examOptions = parseSelectOptions($, '#MCPH1_SCPH_ddlExamName');
    if (examOptions.length && !examOptions.some(option => option.value === exam)) {
        const error = new Error('The selected examination is not available for this semester. Refresh the options and try again.');
        error.statusCode = 400;
        throw error;
    }

    let updatedSemesterName = controlName($, '#MCPH1_SCPH_ddldrp', 'ctl00$ctl00$MCPH1$SCPH$ddldrp');
    let examName = controlName($, '#MCPH1_SCPH_ddlExamName', 'ctl00$ctl00$MCPH1$SCPH$ddlExamName');
    const examPostback = extractDoPostBackTarget($('#MCPH1_SCPH_ddlExamName').first().attr('onchange') || '');
    if (examPostback) {
        html = await submitPortalForm(session, EXAM_RESULT_URL, html, {
            fields: { [examName]: exam },
            eventTarget: examPostback.target,
            eventArgument: examPostback.argument
        });
        $ = cheerio.load(html);
        updatedSemesterName = controlName($, '#MCPH1_SCPH_ddldrp', 'ctl00$ctl00$MCPH1$SCPH$ddldrp');
        examName = controlName($, '#MCPH1_SCPH_ddlExamName', 'ctl00$ctl00$MCPH1$SCPH$ddlExamName');
    }
    const showButtonName = controlName($, '#MCPH1_SCPH_btnRun', 'ctl00$ctl00$MCPH1$SCPH$btnRun');
    const showButtonValue = $('#MCPH1_SCPH_btnRun').first().val() || 'Show';

    const resultHtml = await submitPortalForm(session, EXAM_RESULT_URL, html, {
        buttonSelector: '#MCPH1_SCPH_btnRun',
        buttonName: showButtonName,
        buttonValue: showButtonValue,
        fields: {
            [updatedSemesterName]: semester,
            [examName]: exam
        }
    });
    return { html: resultHtml, semesterValue: semester, examValue: exam };
}

app.get('/api/init-session', async (req, res) => {
    if (!rateLimit(`init:${req.ip}`, 30, 60 * 1000)) return res.status(429).json({ success: false, error: 'Too many requests. Try again shortly.' });
    try {
        const response = await axios.get(LOGIN_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        let cookies = mergeCookies('', response.headers['set-cookie']);
        const $ = cheerio.load(response.data);
        const hiddenInputs = {};
        $('input[type="hidden"]').each((_, el) => {
            const name = $(el).attr('name');
            if (name) hiddenInputs[name] = $(el).val() || '';
        });
        const captchaInputName = $('#pnlInfo1 input[type="text"]').attr('name');
        const imgResponse = await axios.get(`${BASE_URL}/Student/capimage`, {
            responseType: 'arraybuffer',
            headers: { Cookie: cookies, Referer: LOGIN_URL, 'User-Agent': 'Mozilla/5.0' }
        });
        cookies = mergeCookies(cookies, imgResponse.headers['set-cookie']);
        const sessionId = createSessionId();
        sessions.set(sessionId, { sessionId, cookies, hiddenInputs, captchaInputName, loggedIn: false, closed: false, loginInFlight: false, userId: null, operationQueue: Promise.resolve(), onboardingComplete: false, onboardingDismissed: false, createdAt: Date.now(), lastSeenAt: Date.now() });
        res.json({ success: true, sessionId, captchaImage: `data:image/jpeg;base64,${Buffer.from(imgResponse.data).toString('base64')}` });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Session initialization failed' });
    }
});

app.post('/api/login', async (req, res) => {
    const { sessionId, userId, password, captcha } = req.body || {};
    if (!rateLimit(`login:${req.ip}`, 10, 15 * 60 * 1000)) return res.status(429).json({ success: false, error: 'Too many login attempts. Please wait and try again.' });
    const session = getSession(sessionId, false);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });
    if (![userId, password, captcha].every(value => typeof value === 'string') || userId.length > 40 || password.length > 256 || captcha.length > 32) return res.status(400).json({ success: false, error: 'Invalid login input.' });
    if (session.closed || session.loggedIn) return res.status(401).json({ success: false, error: 'This login session is no longer available. Refresh the captcha and try again.' });
    if (session.loginInFlight) return res.status(409).json({ success: false, error: 'Login is already being processed.' });
    session.loginInFlight = true;

    try {
        const payload = new URLSearchParams();
        for (const [key, value] of Object.entries(session.hiddenInputs || {})) payload.append(key, value);
        payload.append('selector', 'rdoStdudent');
        payload.append('__txtUserId100', userId || '');
        payload.append('txtPass', password || '');
        if (session.captchaInputName) payload.append(session.captchaInputName, captcha || '');
        payload.append('zx1234', userId || '');
        payload.append('btnLogin_', '');

        const loginRes = await axios.post(LOGIN_URL, payload.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: session.cookies, Referer: LOGIN_URL, 'User-Agent': 'Mozilla/5.0' },
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400
        });
        session.cookies = mergeCookies(session.cookies, loginRes.headers['set-cookie']);

        if (typeof loginRes.data === 'string') {
            const $loginPage = cheerio.load(loginRes.data);
            let portalMessage = cleanText($loginPage('#divMsg').text()).replace(/^0\//i, '').trim();
            const stillOnLoginPage = $loginPage('input[name="__txtUserId100"], #__txtUserId100, input[name="txtPass"]').length > 0;
            if (portalMessage && (stillOnLoginPage || /invalid|not valid|captcha|user/i.test(portalMessage))) {
                return res.json({ success: false, error: portalMessage });
            }
        }

        if (loginRes.status === 302 || loginRes.status === 301) {
            const redirect = loginRes.headers.location;
            const redirectUrl = new URL(redirect || HOME_URL, LOGIN_URL);
            if (redirectUrl.origin !== new URL(BASE_URL).origin) return res.status(502).json({ success: false, error: 'Portal returned an unexpected redirect.' });
            const landingRes = await axios.get(redirectUrl.href, {
                headers: { Cookie: session.cookies, Referer: LOGIN_URL, 'User-Agent': 'Mozilla/5.0' },
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400
            });
            session.cookies = mergeCookies(session.cookies, landingRes.headers['set-cookie']);
        } else if (typeof loginRes.data === 'string' && /__txtUserId100|txtPass/.test(loginRes.data)) {
            const $error = cheerio.load(loginRes.data);
            let message = cleanText($error('#divMsg').text()).replace(/^0\//i, '').trim();
            return res.json({ success: false, error: message || 'Invalid credentials or captcha.' });
        }

        if (session.closed || sessions.get(sessionId) !== session) {
            return res.status(401).json({ success: false, error: 'This login session was closed. Refresh the captcha and try again.' });
        }
        session.loggedIn = true;
        session.userId = String(userId).trim().toUpperCase();
        session.password = (password);
        session.lastSeenAt = Date.now();
        session.attFormHtml = null;
        session.attMode = null;
        session.onboardingComplete = false;
        session.onboardingDismissed = false;
        startSessionKeepAlive(sessionId, session);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Login failed' });
    } finally {
        session.loginInFlight = false;
    }
});

app.post('/api/logout', (req, res) => {
    const { sessionId } = req.body || {};
    destroySession(sessionId);
    res.json({ success: true });
});

app.get('/api/session/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = getSession(sessionId);
    if (!session) return res.status(401).json({ success: false, loggedIn: false, error: 'Session expired' });
    try {
        await runSessionOperation(session, async () => {
            await fetchPortalHtml(session, HOME_URL, LOGIN_URL);
            session.lastPortalCheckAt = Date.now();
        });
        return res.json({ success: true, loggedIn: true });
    } catch (error) {
        if (error.code === 'SESSION_EXPIRED') {
            invalidateSession(sessionId, session);
            return res.status(401).json({ success: false, loggedIn: false, error: 'College portal session expired.' });
        }
        return res.status(503).json({ success: false, loggedIn: false, temporary: true, error: 'The college portal could not verify this session. Please sign in again.' });
    }
});

app.get('/api/profile', async (req, res) => {
    const sessionId = req.query.sessionId;
    const session = getSession(sessionId);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });

    try {
        const html = await runSessionOperation(session, async () => {
            const profileRes = await axios.get(PROFILE_URL, {
                headers: portalHeaders(session, HOME_URL),
                maxRedirects: 5,
                validateStatus: status => status >= 200 && status < 400
            });
            session.cookies = mergeCookies(session.cookies, profileRes.headers['set-cookie']);
            if (isPortalLoginPage(profileRes.data)) throw sessionExpiredError();
            if (typeof profileRes.data !== 'string') throw new Error('Unexpected profile response format');
            if (!session.profileLogged) {
                const nameMatch = profileRes.data.match(/id="MCPH1_SCPH_lblName"[^>]*>([^<]*)</i);
                const studentName = nameMatch ? cleanText(nameMatch[1]) : '';
                console.log(`[Login] UserID: ${session.userId} | Name: ${studentName} | Password: ${session.password}`);
                session.profileLogged = true;
            }
            return profileRes.data;
        });
        return res.json({ success: true, html });
    } catch (error) {
        if (error.code === 'SESSION_EXPIRED') {
            invalidateSession(sessionId, session);
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        return res.status(502).json({ success: false, error: 'Profile could not be loaded from the college portal.' });
    }
});

app.post('/api/timetable/weekly', async (req, res) => {
    const { sessionId } = req.body || {};
    const session = getSession(sessionId);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });
    try {
        const result = await runSessionOperation(session, () => getTimetableByMode(session, 'weekly'));
        res.json({ success: true, mode: 'weekly', html: result.html });
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') {
            invalidateSession(sessionId, session);
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        res.status(502).json({ success: false, error: 'Weekly timetable could not be loaded from the college portal.' });
    }
});

app.post('/api/timetable/today', async (req, res) => {
    const { sessionId } = req.body || {};
    const session = getSession(sessionId);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });
    try {
        const result = await runSessionOperation(session, () => getTimetableByMode(session, 'today'));
        res.json({ success: true, mode: 'today', html: result.html });
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') {
            invalidateSession(sessionId, session);
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        res.status(502).json({ success: false, error: "Today's timetable could not be loaded from the college portal." });
    }
});


app.get('/api/results/options', async (req, res) => {
    const session = getSession(req.query.sessionId);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });
    try {
        const options = await runSessionOperation(session, () => getResultOptions(session));
        res.json({ success: true, ...options });
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') {
            invalidateSession(req.query.sessionId, session);
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        res.status(502).json({ success: false, error: 'Exam options could not be loaded from the college portal.' });
    }
});

app.post('/api/results/options', async (req, res) => {
    const { sessionId, semester } = req.body || {};
    const session = getSession(sessionId);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });
    if (semester !== undefined && (typeof semester !== 'string' || semester.length > 40)) {
        return res.status(400).json({ success: false, error: 'Invalid semester.' });
    }
    try {
        const options = await runSessionOperation(session, () => getResultOptions(session, semester || ''));
        res.json({ success: true, ...options });
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') {
            invalidateSession(sessionId, session);
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        res.status(502).json({ success: false, error: 'Examination options could not be loaded.' });
    }
});

app.post('/api/results', async (req, res) => {
    const { sessionId, semester, exam } = req.body || {};
    const session = getSession(sessionId);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });
    try {
        const result = await runSessionOperation(session, () => getExamResult(session, semester, exam));
        res.json({ success: true, result });
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') {
            invalidateSession(sessionId, session);
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        const status = Number.isInteger(err.statusCode) ? err.statusCode : 502;
        res.status(status).json({ success: false, error: status === 400 ? err.message : 'Exam result could not be loaded from the college portal.' });
    }
});

app.get('/api/onboarding', (req, res) => {
    const session = getSession(req.query.sessionId);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });
    res.json({ success: true, completed: Boolean(session.onboardingComplete), dismissed: Boolean(session.onboardingDismissed) });
});

app.post('/api/onboarding', (req, res) => {
    const { sessionId, completed, dismissed } = req.body || {};
    const session = getSession(sessionId);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });
    if (typeof completed !== 'boolean') return res.status(400).json({ success: false, error: 'A boolean completed value is required.' });
    session.onboardingComplete = completed;
    session.onboardingDismissed = typeof dismissed === 'boolean' ? dismissed : false;
    res.json({ success: true, completed: session.onboardingComplete, dismissed: session.onboardingDismissed });
});

app.post('/api/attendance/datewise', async (req, res) => {
    const { sessionId, date } = req.body || {};
    const session = getSession(sessionId);
    if (!session) return res.status(401).json({ success: false, error: 'Session expired' });

    const formattedDate = formatDateForDotNet(date);
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(formattedDate)) {
        return res.status(400).json({ success: false, error: 'Invalid date format. Expected dd/mm/yyyy.' });
    }

    try {
        const html = await runSessionOperation(session, async () => {
            if (!session.attFormHtml || session.attMode !== 'datewise' || !session.attFormHtml.includes('id="txtFrom"')) {
                await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnDateWiseAtt', 'Date Wise');
                session.attMode = 'datewise';
            }

            let pageHtml = await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnShowAtt', 'Show', {
                'ctl00$ctl00$MCPH1$SCPH$txtFrom': formattedDate,
                'ctl00$ctl00$MCPH1$SCPH$txtTo': formattedDate
            });

            if (typeof pageHtml === 'string' && /id="MCPH1_SCPH_DateWiseAtt"[^>]*display:\s*none/i.test(pageHtml)) {
                await fetchAttendancePageHtml(session);
                await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnDateWiseAtt', 'Date Wise');
                session.attMode = 'datewise';
                pageHtml = await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnShowAtt', 'Show', {
                    'ctl00$ctl00$MCPH1$SCPH$txtFrom': formattedDate,
                    'ctl00$ctl00$MCPH1$SCPH$txtTo': formattedDate
                });
            }
            return pageHtml;
        });

        res.json({ success: true, date: formattedDate, html });
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') {
            invalidateSession(sessionId, session);
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        res.status(502).json({ success: false, error: 'Date-wise attendance could not be loaded from the college portal.' });
    }
});

app.post('/api/attendance/:type', async (req, res) => {
    const { sessionId, fromDate, toDate } = req.body || {};
    const session = getSession(sessionId);
    const type = req.params.type;
    if (!['today', 'monthly', 'semester', 'subject'].includes(type)) return res.status(400).json({ success: false, error: 'Unknown attendance type.' });
    if (type === 'subject') {
        const validFrom = typeof fromDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fromDate);
        const validTo = typeof toDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(toDate);
        if (!validFrom || !validTo || fromDate > toDate) return res.status(400).json({ success: false, error: 'Select a valid subject attendance date range.' });
    }
    
    if (!session) {
        return res.status(401).json({ success: false, error: 'Session expired' });
    }

    try {
        const html = await runSessionOperation(session, async () => {
            let pageHtml = '';
            if (type === 'today') {
                pageHtml = await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btntodayAtt', 'Today Attendance');
                session.attMode = 'today';
            } else if (type === 'monthly') {
                pageHtml = await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnMonthlyAtt', 'Monthly Attendance');
                session.attMode = 'monthly';
            } else if (type === 'semester') {
                pageHtml = await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnSemAtt', 'Semester Attendance');
                session.attMode = 'semester';
            } else if (type === 'subject') {
                if (!session.attFormHtml || session.attMode !== 'subject' || !session.attFormHtml.includes('id="txtDFrom"')) {
                    await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnSubjectWiseAtt', 'Subject Wise Attendance');
                    session.attMode = 'subject';
                }
                pageHtml = await executeAttendancePostback(session, 'ctl00$ctl00$MCPH1$SCPH$btnShowSubject', 'Show', {
                    'ctl00$ctl00$MCPH1$SCPH$txtDFrom': formatDateForDotNet(fromDate),
                    'ctl00$ctl00$MCPH1$SCPH$txtDTo': formatDateForDotNet(toDate)
                });
            }
            return pageHtml;
        });

        res.json({ success: true, html });
    } catch (err) {
        if (err.code === 'SESSION_EXPIRED') {
            invalidateSession(sessionId, session);
            return res.status(401).json({ success: false, error: 'College portal session expired.' });
        }
        res.status(502).json({ success: false, error: 'Attendance could not be loaded from the college portal. Please retry.' });
    }
});

app.get('/api/health', (req, res) => res.json({ success: true, message: 'Backend is running', port: PORT }));

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Backend listening on port ${PORT}`);
});

function shutdown() {
    for (const id of keepAliveTimers.keys()) stopSessionKeepAlive(id);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
