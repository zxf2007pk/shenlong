import { _ } from 'assets://js/lib/cat.js';

// 腾讯视频（v.qq.com）站源 —— 由 Python 版 腾讯.py 转换而来（cat 类型模板）
// 列表/筛选：pbaccess GetPageData(1000005)；详情：GetPageData(3000010)；
// 搜索：MultiTerminalSearch MbSearch；播放：v.qq.com/x/cover/{cid}/{vid}.html + jx.xmflv.com 解析站

const host = 'https://v.qq.com';
const apihost = 'https://pbaccess.video.qq.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.5410.0 Safari/537.36';

// 频道映射（与 Python 版一致）
const CHANNELS = {
    '电视剧': '100113',
    '电影': '100173',
    '综艺': '100109',
    '纪录片': '100105',
    '动漫': '100119',
    '少儿': '100150',
    '短剧': '110755'
};
const CHANNEL_IDS = Object.values(CHANNELS);

const GPD_BASE = apihost + '/trpc.universal_backend_service.page_server_rpc.PageServer/GetPageData?';
const GPD_PARAMS5 = 'video_appid=1000005&vplatform=2&vversion_name=8.9.10&new_mark_label_enabled=1';
const GPD_PARAMS3 = 'video_appid=3000010&vplatform=2&vversion_name=8.2.96';
const MBS_URL = apihost + '/trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch?vplatform=2';

async function init(cfg) {
    // 预留扩展参数
}

// 通用请求封装：POST JSON 时序列化 body；cat 运行时 req() 返回 {content}
async function request(url, method, data) {
    const reqOptions = {
        method: method,
        headers: {
            'User-Agent': UA,
            'Origin': host,
            'Referer': host + '/'
        }
    };
    if (data !== undefined) {
        reqOptions.headers['Content-Type'] = 'application/json';
        reqOptions.body = JSON.stringify(data);
    }
    const res = await req(url, reqOptions);
    const text = res.content !== undefined ? res.content : res.data;
    return typeof text === 'string' ? JSON.parse(text) : text;
}

// 从 tid 中解析出已知频道 ID（任意位置匹配兜底，覆盖多种 input 形态）
function resolveChannel(tid) {
    const s = String(tid || '');
    for (const id of CHANNEL_IDS) {
        if (s.indexOf(id) >= 0) return id;
    }
    return s;
}

function paramsToQuery(params) {
    const q = [];
    for (const k of Object.keys(params)) q.push(k + '=' + params[k]);
    return q.join('&');
}

function listBody(cid, filterParams) {
    return {
        page_params: {
            channel_id: cid,
            filter_params: filterParams,
            page_type: 'channel_operation',
            page_id: 'channel_list_second_page'
        }
    };
}

// 取响应最末模块的 item_datas（筛选选项与视频条目同在此路径，按字段区分）
function lastItems(data) {
    const mld = data && data.data && data.data.module_list_datas;
    if (!mld || !mld.length) return null;
    const mds = mld[mld.length - 1].module_datas || [];
    if (!mds.length) return null;
    return mds[mds.length - 1].item_data_lists.item_datas || null;
}

function parseTags(raw) {
    try {
        return JSON.parse(raw || '{}') || {};
    } catch (e) {
        return {};
    }
}

// 兼容 tag_1/tag_2 与 "1"/"2" 两种键形态，取第一个有 text 的
function tagText(tag, keys) {
    for (const k of keys) {
        const v = tag[k];
        if (!v) continue;
        if (v.text) return v.text;
        if (v.info && v.info.text) return v.info.text;
    }
    return '';
}

// 列表条目（GetPageData 视频条目，item_params 含 cid）
function videoItem(it) {
    const p = it.item_params || {};
    const cid = p.cid;
    if (!cid) return null;
    const tag = parseTags(p.uni_imgtag || p.imgtag);
    return {
        vod_id: cid,
        vod_name: p.mz_title || p.title || '',
        vod_pic: p.new_pic_hz || p.new_pic_vt,
        vod_year: tagText(tag, ['tag_1', '1', 'tag_2', '2']),
        vod_remarks: tagText(tag, ['tag_4', '4', 'tag_3', '3'])
    };
}

// 首页分类 + 全频道筛选（并发拉取）
async function home() {
    const classes = Object.keys(CHANNELS).map(name => ({ type_id: CHANNELS[name], type_name: name }));
    const filters = {};
    const results = await Promise.all(Object.keys(CHANNELS).map(async name => {
        const cid = CHANNELS[name];
        try {
            const data = await request(GPD_BASE + GPD_PARAMS5, 'POST', listBody(cid, 'sort=75'));
            return { cid: cid, data: data };
        } catch (e) {
            return { cid: cid, data: null };
        }
    }));
    for (const item of results) {
        if (!item.data || !item.data.data || !item.data.data.module_list_datas) continue;
        const items = lastItems(item.data);
        if (!items) continue;
        const filterDict = {};
        for (const it of items) {
            const p = it.item_params || {};
            const key = p.index_item_key;
            if (!key) continue;
            if (!filterDict[key]) {
                filterDict[key] = { key: key, name: p.index_name, value: [] };
            }
            filterDict[key].value.push({ n: p.option_name, v: p.option_value });
        }
        filters[item.cid] = Object.keys(filterDict).map(k => filterDict[k]);
    }
    return JSON.stringify({ class: classes, filters: filters });
}

// 分类列表（翻页 page 必须为字符串，否则 ret:400；pg=1 不带 page 字段）
async function category(tid, pg, filter, extend) {
    extend = extend || {};
    const cid = resolveChannel(tid);
    const params = {
        sort: extend.sort || '75',
        attr: extend.attr || '-1',
        itype: extend.itype || '-1',
        ipay: extend.ipay || '-1',
        iarea: extend.iarea || '-1',
        iyear: extend.iyear || '-1',
        theater: extend.theater || '-1',
        award: extend.award || '-1',
        recommend: extend.recommend || '-1'
    };
    const body = listBody(cid, paramsToQuery(params));
    if (parseInt(pg) !== 1) {
        body.page_params.page = String(pg);
    }
    const data = await request(GPD_BASE + GPD_PARAMS5, 'POST', body);
    const ndata = data && data.data ? data.data : {};
    const list = [];
    const items = lastItems(data) || [];
    for (const it of items) {
        const item = videoItem(it);
        if (item) list.push(item);
    }
    const result = { list: list, page: pg, limit: 90, total: 999999 };
    result.pagecount = ndata.has_next_page ? 9999 : parseInt(pg);
    return JSON.stringify(result);
}

// 详情：详情介绍 + 剧集列表并发拉取，按 tabs 补齐其余分组
async function detail(id) {
    const cid = String(id || '').split('||')[0] || String(id || '');
    const vbody = {
        page_params: { req_from: 'web', cid: cid, vid: '', lid: '', page_type: 'detail_operation', page_id: 'detail_page_introduction' },
        has_cache: 1
    };
    const epbody = {
        page_params: { req_from: 'web_vsite', page_id: 'vsite_episode_list', page_type: 'detail_operation', id_type: '1', page_size: '', cid: cid, vid: '', lid: '', page_num: '', page_context: '', detail_page_type: '1' },
        has_cache: 1
    };
    const vdataPromise = getVdata(vbody);
    const eppromise = getVdata(epbody);
    const vdata = await vdataPromise;
    const edata = await eppromise;

    const pdata = await processTabs(edata, epbody);
    if (!pdata || !pdata.length) {
        return JSON.stringify({ list: [{ vod_play_from: '哎呀翻车啦', vod_play_url: '翻车啦#555' }] });
    }
    try {
        const base = ((vdata.data.module_list_datas || [])[0] || {}).module_datas || [];
        const first = ((base[0] || {}).item_data_lists || {}).item_datas || [];
        const item = first[0] || {};
        const starList = ((item.sub_items || {}).star_list || {}).item_datas || [];
        const actors = starList.map(s => (s.item_params || {}).name);
        const names = [];
        const parts = processPdata(pdata, cid);
        if (parts.plist.length) names.push('腾讯视频');
        if (parts.ylist.length) names.push('预告片');
        if (!names.length) {
            return JSON.stringify({ list: [{ vod_play_from: '哎呀翻车啦', vod_play_url: '翻车啦#555' }] });
        }
        const vod = buildVod(vdata, actors, parts.plist, parts.ylist, names);
        return JSON.stringify({ list: [vod] });
    } catch (e) {
        console.log('detail err: ' + e.message);
        return JSON.stringify({ list: [{ vod_play_from: '哎呀翻车啦', vod_play_url: '翻车啦#555' }] });
    }
}

// 搜索：MultiTerminalSearch MbSearch
async function search(wd, quick) {
    const body = {
        version: '24072901', clientType: 1, filterValue: '', uuid: genUuid(), retry: 0,
        query: String(wd || ''), pagenum: 0, pagesize: 30, queryFrom: 0, searchDatakey: '',
        transInfo: '', isneedQc: true, preQid: '', adClientInfo: '',
        extraInfo: { isNewMarkLabel: '1', multi_terminal_pc: '1' }
    };
    const data = await request(MBS_URL, 'POST', body);
    const boxes = (data && data.data && data.data.areaBoxList) || [];
    const list = [];
    if (boxes.length) {
        const items = boxes[boxes.length - 1].itemList || [];
        for (const k of items) {
            const doc = k.doc || {};
            const vi = k.videoInfo || {};
            if (!doc.id) continue;
            const tag = parseTags(vi.imgTag);
            list.push({
                vod_id: doc.id,
                vod_name: vi.title || '',
                vod_pic: vi.imgUrl || '',
                vod_year: tagText(tag, ['1', 'tag_1', '2', 'tag_2']),
                vod_remarks: tagText(tag, ['4', 'tag_4', '3', 'tag_3'])
            });
        }
    }
    return JSON.stringify({ list: list });
}

// 播放：cid@vid -> v.qq.com/x/cover/{cid}/{vid}.html -> jx.xmflv.com 解析站（parse:1）
async function play(flag, id, flags) {
    const raw = String(id || '');
    // 防御：若 id 里带 "${集名}$" 前缀（个别调用方按整段传入），只取 $ 之后的部分
    const tail = raw.indexOf('$') >= 0 ? raw.slice(raw.lastIndexOf('$') + 1) : raw;
    const ids = tail.split('@');
    if (ids.length < 2) return JSON.stringify({ parse: 1, url: '', header: '' });
    const url = host + '/x/cover/' + ids[0] + '/' + ids[1] + '.html';
    const parseUrl = 'https://jx.xmflv.com/?url=' + url;
    return JSON.stringify({ parse: 1, url: parseUrl, header: '' });
}

// ---- 内部辅助 ----

function getVdata(body) {
    return request(GPD_BASE + GPD_PARAMS3, 'POST', body).catch(e => {
        console.log('getVdata err: ' + e.message);
        return { data: { module_list_datas: [] } };
    });
}

// 剧集列表：基础段 + module_params.tabs 其余分组（page_context 逐组拉取）
async function processTabs(data, body) {
    try {
        const mld = data.data && data.data.module_list_datas;
        if (!mld || !mld.length) return [];
        const last = mld[mld.length - 1];
        const mds = last.module_datas;
        if (!mds || !mds.length) return [];
const lastMod = mds[mds.length - 1];
        const ild = lastMod.item_data_lists.item_datas;
        let pdata = ild.slice();
        // tabs 存于最后一个 module_data 的 module_params 中（与 tengxun.js 一致）
        const mp = (lastMod && lastMod.module_params) || {};
        let tabs = null;
        if (mp.tabs) {
            try { tabs = JSON.parse(mp.tabs); } catch (e) { tabs = null; }
        }
        if (tabs && tabs.length) {
            const remaining = tabs.slice(1);
            const results = await Promise.all(remaining.map(tab => {
                const nbody = JSON.parse(JSON.stringify(body));
                nbody.page_params.page_context = tab.page_context;
                return getVdata(nbody);
            }));
            for (const result of results) {
                if (!result || !result.data || !result.data.module_list_datas) continue;
                const m2 = result.data.module_list_datas;
                const l2 = m2[m2.length - 1];
                const arr = l2.module_datas[l2.module_datas.length - 1].item_data_lists.item_datas;
                pdata = pdata.concat(arr);
            }
        }
        return pdata;
    } catch (e) {
        console.log('processTabs err: ' + e.message);
        return [];
    }
}

// 剧集段格式：{集名}${cid}@{vid}；预告 -> 预告片线路
function processPdata(pdata, cid) {
    const plist = [];
    const ylist = [];
    for (const k of pdata) {
        if (k.item_id) {
            const params = k.item_params || {};
            const unionTitle = String(params.union_title || '').replace(/[$#]/g, '_');
            const pid = unionTitle + '$' + cid + '@' + k.item_id;
            if (unionTitle.indexOf('预告') >= 0) ylist.push(pid);
            else plist.push(pid);
        }
    }
    return { plist: plist, ylist: ylist };
}

function buildVod(vdata, actors, plist, ylist, names) {
    const item = ((vdata.data.module_list_datas || [])[0] || {}).module_datas || [];
    const first = ((item[0] || {}).item_data_lists || {}).item_datas || [];
    const d = (first[0] || {}).item_params || {};
    const urls = [];
    if (plist.length) urls.push(plist.join('#'));
    if (ylist.length) urls.push(ylist.join('#'));
    return {
        type_name: d.sub_genre || '',
        vod_name: d.title || '',
        vod_year: d.year || '',
        vod_area: d.area_name || '',
        vod_remarks: d.holly_online_time || d.hotval || '',
        vod_actor: actors.join(','),
        vod_content: d.cover_description || '',
        vod_play_from: names.join('$$$'),
        vod_play_url: urls.join('$$$')
    };
}

// 括号平衡截块（压缩字面量 ssrPayloads 表达式）
function extractBalanced(str, start) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"' || ch === "'") inStr = false;
            continue;
        }
        if (ch === '"' || ch === "'") { inStr = true; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) return str.slice(start, i + 1);
        }
    }
    return '';
}

function genUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export function __jsEvalReturn() {
    return { init: init, home: home, category: category, detail: detail, play: play, search: search };
}