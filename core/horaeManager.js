/**
 * Horae - 核心管理器
 * 负责元数据的存储、解析、聚合
 */

import { parseStoryDate, calculateRelativeTime, calculateDetailedRelativeTime, generateTimeReference, formatRelativeTime, formatFullDateTime } from '../utils/timeUtils.js';

/**
 * @typedef {Object} HoraeTimestamp
 * @property {string} story_date - 剧情日期，如 "10/1"
 * @property {string} story_time - 剧情时间，如 "15:00" 或 "下午"
 * @property {string} absolute - ISO格式的实际时间戳
 */

/**
 * @typedef {Object} HoraeScene
 * @property {string} location - 场景地点
 * @property {string[]} characters_present - 在场角色列表
 * @property {string} atmosphere - 场景氛围
 */

/**
 * @typedef {Object} HoraeEvent
 * @property {boolean} is_important - 是否重要事件
 * @property {string} level - 事件级别：一般/重要/关键
 * @property {string} summary - 事件摘要
 */

/**
 * @typedef {Object} HoraeItemInfo
 * @property {string|null} icon - emoji图标
 * @property {string|null} holder - 持有者
 * @property {string} location - 位置描述
 */

/**
 * @typedef {Object} HoraeMeta
 * @property {HoraeTimestamp} timestamp
 * @property {HoraeScene} scene
 * @property {Object.<string, string>} costumes - 角色服装 {角色名: 服装描述}
 * @property {Object.<string, HoraeItemInfo>} items - 物品追踪
 * @property {HoraeEvent|null} event
 * @property {Object.<string, string|number>} affection - 好感度
 * @property {Object.<string, {description: string, first_seen: string}>} npcs - 临时NPC
 */

/** 创建空的元数据对象 */
export function createEmptyMeta() {
    return {
        timestamp: {
            story_date: '',
            story_time: '',
            absolute: ''
        },
        scene: {
            location: '',
            characters_present: [],
            atmosphere: ''
        },
        costumes: {},
        items: {},
        deletedItems: [],  // 已消耗/删除的物品名称列表
        events: [],  // 支持多个事件
        affection: {},
        npcs: {},
        agenda: []   // 待办事项
    };
}

/**
 * 提取物品的基本名称（去掉末尾的数量括号）
 * "新鲜牛大骨(5斤)" → "新鲜牛大骨"
 * "清水(9L)" → "清水"
 * "简易急救包" → "简易急救包"（无数量，不变）
 * "简易急救包(已开封)" → 不变（非数字开头的括号不去掉）
 */
// 个体量词：1个 = 就一个，可省略。纯量词(个)(把)也无意义
const COUNTING_CLASSIFIERS = '个把条块张根口份枚只颗支件套双对碗杯盘盆串束扎';
// 容器/批量单位：1箱 = 一箱(里面有很多)，不可省略
// 度量单位(斤/L/kg等)：有实际计量意义，不可省略

// 物品ID：3位数字左补零，如 001, 002, ...
function padItemId(id) { return String(id).padStart(3, '0'); }

function getItemBaseName(name) {
    return name
        .replace(/[\(（][\d][\d\.\/]*[a-zA-Z\u4e00-\u9fff]*[\)）]$/, '')  // 数字+任意单位
        .replace(new RegExp(`[\\(（][${COUNTING_CLASSIFIERS}][\\)）]$`), '')  // 纯个体量词（AI错误格式）
        .trim();
}

/** 按基本名查找已有物品 */
function findExistingItemByBaseName(stateItems, newName) {
    const newBase = getItemBaseName(newName);
    if (stateItems[newName]) return newName;
    for (const existingName of Object.keys(stateItems)) {
        if (getItemBaseName(existingName) === newBase) {
            return existingName;
        }
    }
    return null;
}

/** Horae 管理器 */
class HoraeManager {
    constructor() {
        this.context = null;
        this.settings = null;
    }

    /** 初始化管理器 */
    init(context, settings) {
        this.context = context;
        this.settings = settings;
    }

    /** 获取当前聊天记录 */
    getChat() {
        return this.context?.chat || [];
    }

    /** 获取消息元数据 */
    getMessageMeta(messageIndex) {
        const chat = this.getChat();
        if (messageIndex < 0 || messageIndex >= chat.length) return null;
        return chat[messageIndex].horae_meta || null;
    }

    /** 设置消息元数据 */
    setMessageMeta(messageIndex, meta) {
        const chat = this.getChat();
        if (messageIndex < 0 || messageIndex >= chat.length) return;
        chat[messageIndex].horae_meta = meta;
    }

    /** 聚合所有消息元数据，获取最新状态 */
    getLatestState() {
        const chat = this.getChat();
        const state = createEmptyMeta();
        
        // 从头到尾遍历，后面的覆盖前面的
        for (let i = 0; i < chat.length; i++) {
            const meta = chat[i].horae_meta;
            if (!meta) continue;
            
            if (meta.timestamp?.story_date) {
                state.timestamp.story_date = meta.timestamp.story_date;
            }
            if (meta.timestamp?.story_time) {
                state.timestamp.story_time = meta.timestamp.story_time;
            }
            
            if (meta.scene?.location) {
                state.scene.location = meta.scene.location;
            }
            if (meta.scene?.atmosphere) {
                state.scene.atmosphere = meta.scene.atmosphere;
            }
            if (meta.scene?.characters_present?.length > 0) {
                state.scene.characters_present = [...meta.scene.characters_present];
            }
            
            if (meta.costumes) {
                Object.assign(state.costumes, meta.costumes);
            }
            
            // 物品：合并更新
            if (meta.items) {
                for (let [name, newInfo] of Object.entries(meta.items)) {
                    // 去掉无意义的数量标记
                    // (1) 裸数字1 → 去掉
                    name = name.replace(/[\(（]1[\)）]$/, '').trim();
                    // 个体量词+数字1 → 去掉
                    name = name.replace(new RegExp(`[\\(（]1[${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                    // 纯个体量词 → 去掉
                    name = name.replace(new RegExp(`[\\(（][${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                    // 度量/容器单位保留
                    
                    // 数量为0视为消耗，自动删除
                    const zeroMatch = name.match(/[\(（]0[a-zA-Z\u4e00-\u9fff]*[\)）]$/);
                    if (zeroMatch) {
                        const baseName = getItemBaseName(name);
                        for (const itemName of Object.keys(state.items)) {
                            if (getItemBaseName(itemName).toLowerCase() === baseName.toLowerCase()) {
                                delete state.items[itemName];
                                console.log(`[Horae] 物品数量归零自动删除: ${itemName}`);
                            }
                        }
                        continue;
                    }
                    
                    // 检测消耗状态标记，视为删除
                    const consumedPatterns = /[\(（](已消耗|已用完|已销毁|消耗殆尽|消耗|用尽)[\)）]/;
                    const holderConsumed = /^(消耗|已消耗|已用完|消耗殆尽|用尽|无)$/;
                    if (consumedPatterns.test(name) || holderConsumed.test(newInfo.holder || '')) {
                        const cleanName = name.replace(consumedPatterns, '').trim();
                        const baseName = getItemBaseName(cleanName || name);
                        for (const itemName of Object.keys(state.items)) {
                            if (getItemBaseName(itemName).toLowerCase() === baseName.toLowerCase()) {
                                delete state.items[itemName];
                                console.log(`[Horae] 物品已消耗自动删除: ${itemName}`);
                            }
                        }
                        continue;
                    }
                    
                    // 基本名匹配已有物品
                    const existingKey = findExistingItemByBaseName(state.items, name);
                    
                    if (existingKey) {
                        const existingItem = state.items[existingKey];
                        // 只合并实际存在的字段
                        const mergedItem = { ...existingItem };
                        if (newInfo.icon) mergedItem.icon = newInfo.icon;
                        // importance：只升不降（空 < ! < !!）
                        mergedItem.importance = newInfo.importance || existingItem.importance || '';
                        if (newInfo.holder !== undefined) mergedItem.holder = newInfo.holder;
                        if (newInfo.location !== undefined) mergedItem.location = newInfo.location;
                        // 非空描述才覆盖
                        if (newInfo.description !== undefined && newInfo.description.trim()) {
                            mergedItem.description = newInfo.description;
                        }
                        if (!mergedItem.description) mergedItem.description = existingItem.description || '';
                        
                        if (existingKey !== name) {
                            delete state.items[existingKey];
                            console.log(`[Horae] 物品数量更新: ${existingKey} → ${name}`);
                        }
                        state.items[name] = mergedItem;
                    } else {
                        state.items[name] = newInfo;
                    }
                }
            }
            
            // 处理已删除物品
            if (meta.deletedItems && meta.deletedItems.length > 0) {
                for (const deletedItem of meta.deletedItems) {
                    const deleteBase = getItemBaseName(deletedItem).toLowerCase();
                    for (const itemName of Object.keys(state.items)) {
                        const itemBase = getItemBaseName(itemName).toLowerCase();
                        if (itemName.toLowerCase() === deletedItem.toLowerCase() ||
                            itemBase === deleteBase) {
                            delete state.items[itemName];
                            console.log(`[Horae] 物品已删除: ${itemName}`);
                        }
                    }
                }
            }
            
            // 好感度：支持绝对值和相对值
            if (meta.affection) {
                for (const [key, value] of Object.entries(meta.affection)) {
                    if (typeof value === 'object' && value !== null) {
                        // 新格式：{type: 'absolute'|'relative', value: number|string}
                        if (value.type === 'absolute') {
                            state.affection[key] = value.value;
                        } else if (value.type === 'relative') {
                            const delta = parseInt(value.value) || 0;
                            state.affection[key] = (state.affection[key] || 0) + delta;
                        }
                    } else {
                        // 旧格式兼容
                        const numValue = typeof value === 'number' ? value : parseInt(value) || 0;
                        state.affection[key] = (state.affection[key] || 0) + numValue;
                    }
                }
            }
            
            // NPC：逐字段合并，保留_id
            if (meta.npcs) {
                // 可更新字段 vs 受保护字段
                const updatableFields = ['appearance', 'personality', 'relationship', 'age', 'job', 'note'];
                const protectedFields = ['gender', 'race']; // 性别/种族极少改变
                for (const [name, newNpc] of Object.entries(meta.npcs)) {
                    const existing = state.npcs[name];
                    if (existing) {
                        for (const field of updatableFields) {
                            if (newNpc[field] !== undefined) existing[field] = newNpc[field];
                        }
                        // age变更时记录剧情日期作为基准
                        if (newNpc.age !== undefined && newNpc.age !== '') {
                            if (!existing._ageRefDate) {
                                existing._ageRefDate = state.timestamp.story_date || '';
                            }
                            const oldAgeNum = parseInt(existing.age);
                            const newAgeNum = parseInt(newNpc.age);
                            if (!isNaN(oldAgeNum) && !isNaN(newAgeNum) && oldAgeNum !== newAgeNum) {
                                existing._ageRefDate = state.timestamp.story_date || '';
                            }
                        }
                        // 受保护字段：仅在未设定时才填入
                        for (const field of protectedFields) {
                            if (newNpc[field] !== undefined && !existing[field]) {
                                existing[field] = newNpc[field];
                            }
                        }
                        if (newNpc.last_seen) existing.last_seen = newNpc.last_seen;
                    } else {
                        state.npcs[name] = {
                            appearance: newNpc.appearance || '',
                            personality: newNpc.personality || '',
                            relationship: newNpc.relationship || '',
                            gender: newNpc.gender || '',
                            age: newNpc.age || '',
                            race: newNpc.race || '',
                            job: newNpc.job || '',
                            note: newNpc.note || '',
                            _ageRefDate: newNpc.age ? (state.timestamp.story_date || '') : '',
                            first_seen: newNpc.first_seen || new Date().toISOString(),
                            last_seen: newNpc.last_seen || new Date().toISOString()
                        };
                    }
                }
            }
        }
        
        // 为无ID物品分配ID
        let maxId = 0;
        for (const info of Object.values(state.items)) {
            if (info._id) {
                const num = parseInt(info._id, 10);
                if (num > maxId) maxId = num;
            }
        }
        for (const info of Object.values(state.items)) {
            if (!info._id) {
                maxId++;
                info._id = padItemId(maxId);
            }
        }
        
        // 为无ID的NPC分配ID
        let maxNpcId = 0;
        for (const info of Object.values(state.npcs)) {
            if (info._id) {
                const num = parseInt(info._id, 10);
                if (num > maxNpcId) maxNpcId = num;
            }
        }
        for (const info of Object.values(state.npcs)) {
            if (!info._id) {
                maxNpcId++;
                info._id = padItemId(maxNpcId);
            }
        }
        
        return state;
    }

    /** 根据剧情时间推移计算NPC当前年龄 */
    calcCurrentAge(npcInfo, currentStoryDate) {
        const original = npcInfo.age || '';
        const refDate = npcInfo._ageRefDate || '';
        
        // 无法推算的情况：无年龄、无参考日期、无当前日期
        if (!original || !refDate || !currentStoryDate) {
            return { display: original, original, changed: false };
        }
        
        const ageNum = parseInt(original);
        if (isNaN(ageNum)) {
            // 非数字年龄，无法推算
            return { display: original, original, changed: false };
        }
        
        const refParsed = parseStoryDate(refDate);
        const curParsed = parseStoryDate(currentStoryDate);
        
        // 需要两者都是 standard 类型且有年份才能推算
        if (!refParsed || !curParsed || refParsed.type !== 'standard' || curParsed.type !== 'standard') {
            return { display: original, original, changed: false };
        }
        if (!refParsed.year || !curParsed.year) {
            return { display: original, original, changed: false };
        }
        
        let yearDiff = curParsed.year - refParsed.year;
        
        // 月日判断是否已过生日
        if (refParsed.month && curParsed.month) {
            if (curParsed.month < refParsed.month || 
                (curParsed.month === refParsed.month && (curParsed.day || 1) < (refParsed.day || 1))) {
                yearDiff -= 1;
            }
        }
        
        if (yearDiff <= 0) {
            return { display: original, original, changed: false };
        }
        
        const currentAge = ageNum + yearDiff;
        return { 
            display: String(currentAge), 
            original, 
            changed: true 
        };
    }

    /** 通过ID查找物品 */
    findItemById(items, id) {
        const normalizedId = id.replace(/^#/, '').trim();
        for (const [name, info] of Object.entries(items)) {
            if (info._id === normalizedId || info._id === padItemId(parseInt(normalizedId, 10))) {
                return [name, info];
            }
        }
        return null;
    }

    /** 获取事件列表（用于时间线显示） */
    getEvents(limit = 50, filterLevel = 'all') {
        const chat = this.getChat();
        const events = [];
        
        for (let i = 0; i < chat.length && events.length < limit; i++) {
            const meta = chat[i].horae_meta;
            
            // 支持新格式（events数组）和旧格式（单个event）
            const metaEvents = meta?.events || (meta?.event ? [meta.event] : []);
            
            for (let j = 0; j < metaEvents.length; j++) {
                const evt = metaEvents[j];
                if (!evt?.summary) continue;
                
                if (filterLevel !== 'all' && evt.level !== filterLevel) {
                    continue;
                }
                
                events.push({
                    messageIndex: i,
                    eventIndex: j,  // 事件在该消息中的索引
                    timestamp: meta.timestamp,
                    event: evt
                });
                
                if (events.length >= limit) break;
            }
        }
        
        return events;
    }

    /** 获取重要事件列表（兼容旧调用） */
    getImportantEvents(limit = 50) {
        return this.getEvents(limit, 'all');
    }

    /** 生成紧凑的上下文注入内容 */
    generateCompactPrompt() {
        const state = this.getLatestState();
        const lines = [];
        
        // 状态快照头
        lines.push('[当前状态快照——对比本回合剧情，仅在<horae>中输出发生实质变化的字段]');
        
        const sendTimeline = this.settings?.sendTimeline !== false;
        const sendCharacters = this.settings?.sendCharacters !== false;
        const sendItems = this.settings?.sendItems !== false;
        
        // 时间
        if (state.timestamp.story_date) {
            const fullDateTime = formatFullDateTime(state.timestamp.story_date, state.timestamp.story_time);
            lines.push(`[时间|${fullDateTime}]`);
            
            // 时间参考
            if (sendTimeline) {
                const timeRef = generateTimeReference(state.timestamp.story_date);
                if (timeRef && timeRef.type === 'standard') {
                    // 标准日历
                    lines.push(`[时间参考|昨天=${timeRef.yesterday}|前天=${timeRef.dayBefore}|3天前=${timeRef.threeDaysAgo}]`);
                } else if (timeRef && timeRef.type === 'fantasy') {
                    // 奇幻日历
                    lines.push(`[时间参考|奇幻日历模式，参见剧情轨迹中的相对时间标记]`);
                }
            }
        }
        
        // 场景
        if (state.scene.location) {
            let sceneStr = `[场景|${state.scene.location}`;
            if (state.scene.atmosphere) {
                sceneStr += `|${state.scene.atmosphere}`;
            }
            sceneStr += ']';
            lines.push(sceneStr);
        }
        
        // 在场角色和服装
        if (sendCharacters) {
            const presentChars = state.scene.characters_present || [];
            
            if (presentChars.length > 0) {
                const charStrs = [];
                for (const char of presentChars) {
                    // 模糊匹配服装
                    const costumeKey = Object.keys(state.costumes || {}).find(
                        k => k === char || k.includes(char) || char.includes(k)
                    );
                    if (costumeKey && state.costumes[costumeKey]) {
                        charStrs.push(`${char}(${state.costumes[costumeKey]})`);
                    } else {
                        charStrs.push(char);
                    }
                }
                lines.push(`[在场|${charStrs.join('|')}]`);
            }
        }
        
        // 物品
        if (sendItems) {
            const items = Object.entries(state.items);
            if (items.length > 0) {
                lines.push('\n[物品清单]');
                for (const [name, info] of items) {
                    const id = info._id || '???';
                    const icon = info.icon || '';
                    const imp = info.importance === '!!' ? '关键' : info.importance === '!' ? '重要' : '';
                    const desc = info.description ? ` | ${info.description}` : '';
                    const holder = info.holder || '';
                    const loc = info.location ? `@${info.location}` : '';
                    const impTag = imp ? `[${imp}]` : '';
                    lines.push(`#${id} ${icon}${name}${impTag}${desc} = ${holder}${loc}`);
                }
            } else {
                lines.push('\n[物品清单] (空)');
            }
        }
        
        // 好感度
        if (sendCharacters) {
            const affections = Object.entries(state.affection).filter(([_, v]) => v !== 0);
            if (affections.length > 0) {
                const affStr = affections.map(([k, v]) => `${k}:${v > 0 ? '+' : ''}${v}`).join('|');
                lines.push(`[好感|${affStr}]`);
            }
            
            // NPC信息
            const npcs = Object.entries(state.npcs);
            if (npcs.length > 0) {
                lines.push('\n[已知NPC]');
                for (const [name, info] of npcs) {
                    const id = info._id || '?';
                    const app = info.appearance || '';
                    const per = info.personality || '';
                    const rel = info.relationship || '';
                    // 主体：N编号 名｜外貌=性格@关系
                    let npcStr = `N${id} ${name}`;
                    if (app || per || rel) {
                        npcStr += `｜${app}=${per}@${rel}`;
                    }
                    // 扩展字段
                    const extras = [];
                    if (info.gender) extras.push(`性别:${info.gender}`);
                    if (info.age) {
                        const ageResult = this.calcCurrentAge(info, state.timestamp.story_date);
                        extras.push(`年龄:${ageResult.display}`);
                    }
                    if (info.race) extras.push(`种族:${info.race}`);
                    if (info.job) extras.push(`职业:${info.job}`);
                    if (info.note) extras.push(`补充:${info.note}`);
                    if (extras.length > 0) npcStr += `~${extras.join('~')}`;
                    lines.push(npcStr);
                }
            }
        }
        
        // 待办事项
        const chatForAgenda = this.getChat();
        const allAgendaItems = [];
        const seenTexts = new Set();
        const userAgenda = chatForAgenda?.[0]?.horae_meta?.agenda || [];
        for (const item of userAgenda) {
            if (!seenTexts.has(item.text)) {
                allAgendaItems.push(item);
                seenTexts.add(item.text);
            }
        }
        // AI写入的
        if (chatForAgenda) {
            for (let i = 1; i < chatForAgenda.length; i++) {
                const msgAgenda = chatForAgenda[i].horae_meta?.agenda;
                if (msgAgenda?.length > 0) {
                    for (const item of msgAgenda) {
                        if (!seenTexts.has(item.text)) {
                            allAgendaItems.push(item);
                            seenTexts.add(item.text);
                        }
                    }
                }
            }
        }
        const activeAgenda = allAgendaItems.filter(a => !a.done);
        if (activeAgenda.length > 0) {
            lines.push('\n[待办事项]');
            for (const item of activeAgenda) {
                const datePrefix = item.date ? `${item.date} ` : '';
                lines.push(`· ${datePrefix}${item.text}`);
            }
        }
        
        // 剧情轨迹
        if (sendTimeline) {
            const events = this.getEvents(100, 'all');  // 获取更多事件
            if (events.length > 0) {
                lines.push('\n[剧情轨迹]');
                
                const currentDate = state.timestamp?.story_date || '';
                
                const getLevelMark = (level) => {
                    if (level === '关键') return '★';
                    if (level === '重要') return '●';
                    return '○';
                };
                
                const getRelativeDesc = (eventDate) => {
                    if (!eventDate || !currentDate) return '';
                    const result = calculateDetailedRelativeTime(eventDate, currentDate);
                    if (result.days === null || result.days === undefined) return '';
                    
                    const { days, fromDate, toDate } = result;
                    
                    if (days === 0) return '(Hôm nay)';
                    if (days === 1) return '(Hôm qua)';
                    if (days === 2) return '(Hôm kia)';
                    if (days === 3) return '(3 ngày trước)';
                    if (days === -1) return '(Ngày mai)';
                    if (days === -2) return '(Ngày kia)';
                    if (days === -3) return '(3 ngày nữa)';
                    
                    // 上周几（4-13天前且有日期信息）
                    if (days >= 4 && days <= 13 && fromDate) {
                        const WEEKDAY_NAMES = ['CN', 'Hai', 'Ba', 'Tư', 'Năm', 'Sáu', 'Bảy'];
                        const weekday = fromDate.getDay();
                        return `(Thứ ${WEEKDAY_NAMES[weekday]} tuần trước)`;
                    }
                    
                    // Tháng trước
                    if (days >= 20 && days < 60 && fromDate && toDate) {
                        const fromMonth = fromDate.getMonth();
                        const toMonth = toDate.getMonth();
                        if (fromMonth !== toMonth) {
                            return `(Ngày ${fromDate.getDate()} tháng trước)`;
                        }
                    }
                    
                    // Năm ngoái
                    if (days >= 300 && fromDate && toDate) {
                        const fromYear = fromDate.getFullYear();
                        const toYear = toDate.getFullYear();
                        if (fromYear < toYear) {
                            const fromMonth = fromDate.getMonth() + 1;
                            return `(Tháng ${fromMonth} năm ngoái)`;
                        }
                    }
                    
                    // 通用格式
                    if (days > 0 && days < 30) return `(${days} ngày trước)`;
                    if (days > 0) return `(${Math.round(days / 30)} tháng trước)`;
                    if (days === -999 || days === -998 || days === -997) return '';
                    return '';
                };
                
                // 按消息楼层排序
                const sortedEvents = [...events].sort((a, b) => {
                    return (a.messageIndex || 0) - (b.messageIndex || 0);
                });
                
                // 筛选：关键/重要全部 + 最近30条一般
                const criticalAndImportant = sortedEvents.filter(e => 
                    e.event?.level === '关键' || e.event?.level === '重要'
                );
                const normalEvents = sortedEvents.filter(e => 
                    e.event?.level === '一般' || !e.event?.level
                ).slice(-30);  // 只取最近30条一般事件
                
                // 合并后按楼层排序
                const allToShow = [...criticalAndImportant, ...normalEvents]
                    .sort((a, b) => (a.messageIndex || 0) - (b.messageIndex || 0));
                
                for (const e of allToShow) {
                    const mark = getLevelMark(e.event?.level);
                    const date = e.timestamp?.story_date || '?';
                    const time = e.timestamp?.story_time || '';
                    const timeStr = time ? `${date} ${time}` : date;
                    const relativeDesc = getRelativeDesc(e.timestamp?.story_date);
                    const msgNum = e.messageIndex !== undefined ? `#${e.messageIndex}` : '';
                    lines.push(`${mark} ${msgNum} ${timeStr}${relativeDesc}: ${e.event.summary}`);
                }
            }
        }
        
        // 自定义表格数据
        const chat = this.getChat();
        const firstMsg = chat?.[0];
        const customTables = firstMsg?.horae_meta?.customTables || this.settings?.customTables || [];
        for (const table of customTables) {
            const rows = table.rows || 2;
            const cols = table.cols || 2;
            const data = table.data || {};
            
            // 有内容或有填表说明才输出
            const hasContent = Object.values(data).some(v => v && v.trim());
            const hasPrompt = table.prompt && table.prompt.trim();
            if (!hasContent && !hasPrompt) continue;
            
            const tableName = table.name || '自定义表格';
            lines.push(`\n[${tableName}]`);
            
            if (table.prompt && table.prompt.trim()) {
                lines.push(`(填写要求: ${table.prompt.trim()})`);
            }
            
            // 智能展示：隐藏空列和尾部空行
            // 1. 检测有数据的列
            const activeCols = [0]; // col 0 = 行标题，始终显示
            const emptyCols = [];   // 完全空的数据列
            for (let c = 1; c < cols; c++) {
                let colHasData = false;
                for (let r = 1; r < rows; r++) {
                    if (data[`${r}-${c}`] && data[`${r}-${c}`].trim()) {
                        colHasData = true;
                        break;
                    }
                }
                if (colHasData) {
                    activeCols.push(c);
                } else {
                    emptyCols.push(c);
                }
            }
            
            // 2. 检测最后有数据的行
            let lastDataRow = 0;
            for (let r = rows - 1; r >= 1; r--) {
                for (let c = 1; c < cols; c++) {
                    if (data[`${r}-${c}`] && data[`${r}-${c}`].trim()) {
                        lastDataRow = r;
                        break;
                    }
                }
                if (lastDataRow > 0) break;
            }
            // 至少显示第1行
            if (lastDataRow === 0) lastDataRow = 1;
            
            // 3. 输出表头行
            const headerRow = activeCols.map(c => data[`0-${c}`] || (c === 0 ? '表头' : `列${c}`));
            lines.push(headerRow.join(' | '));
            
            // 4. 输出数据行
            for (let r = 1; r <= lastDataRow; r++) {
                const rowData = activeCols.map(c => {
                    if (c === 0) return data[`${r}-0`] || `${r}`;
                    return data[`${r}-${c}`] || '-';
                });
                lines.push(rowData.join(' | '));
            }
            
            // 5. 标注被省略的尾部空行
            if (lastDataRow < rows - 1) {
                lines.push(`(共${rows - 1}行，第${lastDataRow + 1}-${rows - 1}行暂无数据)`);
            }
            
            // 6. 提示空列
            if (emptyCols.length > 0) {
                const emptyColNames = emptyCols.map(c => data[`0-${c}`] || `列${c}`);
                lines.push(`(${emptyColNames.join('、')}：Tạm thời không có dữ liệu, cấm điền khi sự kiện tương ứng chưa xảy ra)`);
            }
        }
        
        return lines.join('\n');
    }

    /** 获取好感度等级描述 */
    getAffectionLevel(value) {
        if (value >= 80) return 'Tri kỷ';
        if (value >= 60) return 'Thân mật';
        if (value >= 40) return 'Có cảm tình';
        if (value >= 20) return 'Thân thiện';
        if (value >= 0) return 'Trung lập';
        if (value >= -20) return 'Lạnh nhạt';
        if (value >= -40) return 'Ghét bỏ';
        if (value >= -60) return 'Thù địch';
        return 'Căm thù';
    }

    /** 解析AI回复中的horae标签 */
    parseHoraeTag(message) {
        if (!message) return null;
        
        let match = message.match(/<horae>([\s\S]*?)<\/horae>/i);
        if (!match) {
            match = message.match(/<!--horae([\s\S]*?)-->/i);
        }
        
        const eventMatch = message.match(/<horaeevent>([\s\S]*?)<\/horaeevent>/i);
        const tableMatches = [...message.matchAll(/<horaetable[:：]\s*(.+?)>([\s\S]*?)<\/horaetable>/gi)];
        
        if (!match && !eventMatch && tableMatches.length === 0) return null;
        
        const content = match ? match[1].trim() : '';
        const eventContent = eventMatch ? eventMatch[1].trim() : '';
        const lines = content.split('\n').concat(eventContent.split('\n'));
        
        const result = {
            timestamp: {},
            costumes: {},
            items: {},
            deletedItems: [],
            events: [],  // 支持多个事件
            affection: {},
            npcs: {},
            scene: {},
            agenda: [],
            deletedAgenda: []
        };
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            
            // time:10/1 15:00 或 time:小镇历永夜2931年 2月1日(五) 20:30
            if (trimmedLine.startsWith('time:')) {
                const timeStr = trimmedLine.substring(5).trim();
                // 从末尾分离 HH:MM 时钟时间
                const clockMatch = timeStr.match(/\b(\d{1,2}:\d{2})\s*$/);
                if (clockMatch) {
                    result.timestamp.story_time = clockMatch[1];
                    result.timestamp.story_date = timeStr.substring(0, timeStr.lastIndexOf(clockMatch[1])).trim();
                } else {
                    // 无时钟时间，整个字符串作为日期
                    result.timestamp.story_date = timeStr;
                    result.timestamp.story_time = '';
                }
            }
            // location:咖啡馆二楼
            else if (trimmedLine.startsWith('location:')) {
                result.scene.location = trimmedLine.substring(9).trim();
            }
            // atmosphere:轻松
            else if (trimmedLine.startsWith('atmosphere:')) {
                result.scene.atmosphere = trimmedLine.substring(11).trim();
            }
            // characters:爱丽丝,鲍勃
            else if (trimmedLine.startsWith('characters:')) {
                const chars = trimmedLine.substring(11).trim();
                result.scene.characters_present = chars.split(/[,，]/).map(c => c.trim()).filter(Boolean);
            }
            // costume:爱丽丝=白色连衣裙
            else if (trimmedLine.startsWith('costume:')) {
                const costumeStr = trimmedLine.substring(8).trim();
                const eqIndex = costumeStr.indexOf('=');
                if (eqIndex > 0) {
                    const char = costumeStr.substring(0, eqIndex).trim();
                    const costume = costumeStr.substring(eqIndex + 1).trim();
                    result.costumes[char] = costume;
                }
            }
            // item-:物品名 表示物品已消耗/删除
            else if (trimmedLine.startsWith('item-:')) {
                const itemName = trimmedLine.substring(6).trim();
                const cleanName = itemName.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, '').trim();
                if (cleanName) {
                    result.deletedItems.push(cleanName);
                }
            }
            // item:🍺劣质麦酒|描述=酒馆@吧台 / item!:📜重要物品|特殊功能描述=角色@位置 / item!!:💎关键物品=@位置
            else if (trimmedLine.startsWith('item!!:') || trimmedLine.startsWith('item!:') || trimmedLine.startsWith('item:')) {
                let importance = '';  // 一般用空字符串
                let itemStr;
                if (trimmedLine.startsWith('item!!:')) {
                    importance = '!!';  // 关键
                    itemStr = trimmedLine.substring(7).trim();
                } else if (trimmedLine.startsWith('item!:')) {
                    importance = '!';   // 重要
                    itemStr = trimmedLine.substring(6).trim();
                } else {
                    itemStr = trimmedLine.substring(5).trim();
                }
                
                const eqIndex = itemStr.indexOf('=');
                if (eqIndex > 0) {
                    let itemNamePart = itemStr.substring(0, eqIndex).trim();
                    const rest = itemStr.substring(eqIndex + 1).trim();
                    
                    let icon = null;
                    let itemName = itemNamePart;
                    let description = undefined;  // undefined = 合并时不覆盖原有描述
                    
                    const emojiMatch = itemNamePart.match(/^([\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{1F900}-\u{1F9FF}]|[\u{1FA00}-\u{1FA6F}]|[\u{1FA70}-\u{1FAFF}]|[\u{231A}-\u{231B}]|[\u{23E9}-\u{23F3}]|[\u{23F8}-\u{23FA}]|[\u{25AA}-\u{25AB}]|[\u{25B6}]|[\u{25C0}]|[\u{25FB}-\u{25FE}]|[\u{2614}-\u{2615}]|[\u{2648}-\u{2653}]|[\u{267F}]|[\u{2693}]|[\u{26A1}]|[\u{26AA}-\u{26AB}]|[\u{26BD}-\u{26BE}]|[\u{26C4}-\u{26C5}]|[\u{26CE}]|[\u{26D4}]|[\u{26EA}]|[\u{26F2}-\u{26F3}]|[\u{26F5}]|[\u{26FA}]|[\u{26FD}]|[\u{2702}]|[\u{2705}]|[\u{2708}-\u{270D}]|[\u{270F}]|[\u{2712}]|[\u{2714}]|[\u{2716}]|[\u{271D}]|[\u{2721}]|[\u{2728}]|[\u{2733}-\u{2734}]|[\u{2744}]|[\u{2747}]|[\u{274C}]|[\u{274E}]|[\u{2753}-\u{2755}]|[\u{2757}]|[\u{2763}-\u{2764}]|[\u{2795}-\u{2797}]|[\u{27A1}]|[\u{27B0}]|[\u{27BF}]|[\u{2934}-\u{2935}]|[\u{2B05}-\u{2B07}]|[\u{2B1B}-\u{2B1C}]|[\u{2B50}]|[\u{2B55}]|[\u{3030}]|[\u{303D}]|[\u{3297}]|[\u{3299}])/u);
                    if (emojiMatch) {
                        icon = emojiMatch[1];
                        itemNamePart = itemNamePart.substring(icon.length).trim();
                    }
                    
                    const pipeIndex = itemNamePart.indexOf('|');
                    if (pipeIndex > 0) {
                        itemName = itemNamePart.substring(0, pipeIndex).trim();
                        const descText = itemNamePart.substring(pipeIndex + 1).trim();
                        if (descText) description = descText;
                    } else {
                        itemName = itemNamePart;
                    }
                    
                    // 去掉无意义的数量标记
                    itemName = itemName.replace(/[\(（]1[\)）]$/, '').trim();
                    itemName = itemName.replace(new RegExp(`[\\(（]1[${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                    itemName = itemName.replace(new RegExp(`[\\(（][${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                    
                    const atIndex = rest.indexOf('@');
                    const itemInfo = {
                        icon: icon,
                        importance: importance,
                        holder: atIndex >= 0 ? (rest.substring(0, atIndex).trim() || null) : (rest || null),
                        location: atIndex >= 0 ? (rest.substring(atIndex + 1).trim() || '') : ''
                    };
                    if (description !== undefined) itemInfo.description = description;
                    result.items[itemName] = itemInfo;
                }
            }
            // event:重要|爱丽丝坦白了秘密
            else if (trimmedLine.startsWith('event:')) {
                const eventStr = trimmedLine.substring(6).trim();
                const parts = eventStr.split('|');
                if (parts.length >= 2) {
                    const levelRaw = parts[0].trim();
                    const summary = parts.slice(1).join('|').trim();
                    
                    let level = '一般';
                    if (levelRaw === '关键' || levelRaw.toLowerCase() === 'critical') {
                        level = '关键';
                    } else if (levelRaw === '重要' || levelRaw.toLowerCase() === 'important') {
                        level = '重要';
                    }
                    
                    result.events.push({
                        is_important: level === '重要' || level === '关键',
                        level: level,
                        summary: summary
                    });
                }
            }
            // affection:鲍勃=65 或 affection:鲍勃+5（兼容新旧格式）
            // 容忍AI附加注解如 affection:汤姆=18(+0)|观察到xxx，只提取名字和数值
            else if (trimmedLine.startsWith('affection:')) {
                const affStr = trimmedLine.substring(10).trim();
                // 新格式：角色名=数值（绝对值，允许带正负号如 =+28 或 =-15）
                const absoluteMatch = affStr.match(/^(.+?)=\s*([+\-]?\d+)/);
                if (absoluteMatch) {
                    const key = absoluteMatch[1].trim();
                    const value = parseInt(absoluteMatch[2]);
                    result.affection[key] = { type: 'absolute', value: value };
                } else {
                    // 旧格式：角色名+/-数值（相对值，无=号）— 允许数值后跟任意注解
                    const relativeMatch = affStr.match(/^(.+?)([+\-]\d+)/);
                    if (relativeMatch) {
                        const key = relativeMatch[1].trim();
                        const value = relativeMatch[2];
                        result.affection[key] = { type: 'relative', value: value };
                    }
                }
            }
            // npc:名|外貌=性格@关系~性别:男~年龄:25~种族:人类~职业:佣兵~补充:xxx
            // 使用 ~ 分隔扩展字段（key:value），不依赖顺序
            else if (trimmedLine.startsWith('npc:')) {
                const npcStr = trimmedLine.substring(4).trim();
                const npcInfo = this._parseNpcFields(npcStr);
                const name = npcInfo._name;
                delete npcInfo._name;
                
                if (name) {
                    npcInfo.last_seen = new Date().toISOString();
                    if (!result.npcs[name]) {
                        npcInfo.first_seen = new Date().toISOString();
                    }
                    result.npcs[name] = npcInfo;
                }
            }
            // agenda-:已完成待办内容 / agenda:订立日期|内容
            else if (trimmedLine.startsWith('agenda-:')) {
                const delStr = trimmedLine.substring(8).trim();
                if (delStr) {
                    const pipeIdx = delStr.indexOf('|');
                    const text = pipeIdx > 0 ? delStr.substring(pipeIdx + 1).trim() : delStr;
                    if (text) {
                        result.deletedAgenda.push(text);
                    }
                }
            }
            else if (trimmedLine.startsWith('agenda:')) {
                const agendaStr = trimmedLine.substring(7).trim();
                const pipeIdx = agendaStr.indexOf('|');
                if (pipeIdx > 0) {
                    const dateStr = agendaStr.substring(0, pipeIdx).trim();
                    const text = agendaStr.substring(pipeIdx + 1).trim();
                    if (text) {
                        result.agenda.push({ date: dateStr, text, source: 'ai', done: false });
                    }
                } else if (agendaStr) {
                    // 容错：无日期分隔
                    result.agenda.push({ date: '', text: agendaStr, source: 'ai', done: false });
                }
            }
        }

        // 解析自定义表格数据
        if (tableMatches.length > 0) {
            result.tableUpdates = [];
            for (const tm of tableMatches) {
                const tableName = tm[1].trim();
                const tableContent = tm[2].trim();
                const updates = this._parseTableCellEntries(tableContent);
                
                if (Object.keys(updates).length > 0) {
                    result.tableUpdates.push({ name: tableName, updates });
                }
            }
        }

        return result;
    }

    /** 将解析结果合并到元数据 */
    mergeParsedToMeta(baseMeta, parsed) {
        const meta = baseMeta ? JSON.parse(JSON.stringify(baseMeta)) : createEmptyMeta();
        
        if (parsed.timestamp?.story_date) {
            meta.timestamp.story_date = parsed.timestamp.story_date;
        }
        if (parsed.timestamp?.story_time) {
            meta.timestamp.story_time = parsed.timestamp.story_time;
        }
        meta.timestamp.absolute = new Date().toISOString();
        
        if (parsed.scene?.location) {
            meta.scene.location = parsed.scene.location;
        }
        if (parsed.scene?.atmosphere) {
            meta.scene.atmosphere = parsed.scene.atmosphere;
        }
        if (parsed.scene?.characters_present?.length > 0) {
            meta.scene.characters_present = parsed.scene.characters_present;
        }
        
        if (parsed.costumes) {
            Object.assign(meta.costumes, parsed.costumes);
        }
        
        if (parsed.items) {
            Object.assign(meta.items, parsed.items);
        }
        
        if (parsed.deletedItems && parsed.deletedItems.length > 0) {
            if (!meta.deletedItems) meta.deletedItems = [];
            meta.deletedItems = [...new Set([...meta.deletedItems, ...parsed.deletedItems])];
        }
        
        // 支持新格式（events数组）和旧格式（单个event）
        if (parsed.events && parsed.events.length > 0) {
            meta.events = parsed.events;
        } else if (parsed.event) {
            // 兼容旧格式：转换为数组
            meta.events = [parsed.event];
        }
        
        if (parsed.affection) {
            Object.assign(meta.affection, parsed.affection);
        }
        
        if (parsed.npcs) {
            Object.assign(meta.npcs, parsed.npcs);
        }
        
        // 追加AI写入的待办
        if (parsed.agenda && parsed.agenda.length > 0) {
            if (!meta.agenda) meta.agenda = [];
            for (const item of parsed.agenda) {
                // 去重
                const isDupe = meta.agenda.some(a => a.text === item.text);
                if (!isDupe) {
                    meta.agenda.push(item);
                }
            }
        }
        
        // tableUpdates 作为副属性传递
        if (parsed.tableUpdates) {
            meta._tableUpdates = parsed.tableUpdates;
        }
        
        return meta;
    }

    /** 全局删除已完成的待办事项 */
    removeCompletedAgenda(deletedTexts) {
        const chat = this.getChat();
        if (!chat || deletedTexts.length === 0) return;

        const isMatch = (agendaText, deleteText) => {
            if (!agendaText || !deleteText) return false;
            // 精确匹配 或 互相包含（允许AI缩写/扩写）
            return agendaText === deleteText ||
                   agendaText.includes(deleteText) ||
                   deleteText.includes(agendaText);
        };

        if (chat[0]?.horae_meta?.agenda) {
            chat[0].horae_meta.agenda = chat[0].horae_meta.agenda.filter(
                a => !deletedTexts.some(dt => isMatch(a.text, dt))
            );
        }

        for (let i = 1; i < chat.length; i++) {
            if (chat[i]?.horae_meta?.agenda?.length > 0) {
                chat[i].horae_meta.agenda = chat[i].horae_meta.agenda.filter(
                    a => !deletedTexts.some(dt => isMatch(a.text, dt))
                );
            }
        }
    }

    /** 处理AI回复，解析标签并存储元数据 */
    processAIResponse(messageIndex, messageContent) {
        const parsed = this.parseHoraeTag(messageContent);
        
        if (parsed) {
            const existingMeta = this.getMessageMeta(messageIndex);
            const newMeta = this.mergeParsedToMeta(existingMeta, parsed);
            
            // 处理表格更新
            if (newMeta._tableUpdates) {
                // 记录表格贡献，用于回退
                newMeta.tableContributions = newMeta._tableUpdates;
                this.applyTableUpdates(newMeta._tableUpdates);
                delete newMeta._tableUpdates;
            }
            
            // 处理AI标记已完成的待办
            if (parsed.deletedAgenda && parsed.deletedAgenda.length > 0) {
                this.removeCompletedAgenda(parsed.deletedAgenda);
            }
            
            this.setMessageMeta(messageIndex, newMeta);
            return true;
        } else {
            // 无标签，创建空元数据
            if (!this.getMessageMeta(messageIndex)) {
                this.setMessageMeta(messageIndex, createEmptyMeta());
            }
            return false;
        }
    }

    /**
     * 解析NPC字段
     * 格式: 名|外貌=性格@关系~性别:男~年龄:25~种族:人类~职业:佣兵~补充:xxx
     */
    _parseNpcFields(npcStr) {
        const info = {};
        if (!npcStr) return { _name: '' };
        
        // 1. 分离扩展字段
        const tildeParts = npcStr.split('~');
        const mainPart = tildeParts[0].trim(); // 名|外貌=性格@关系
        
        for (let i = 1; i < tildeParts.length; i++) {
            const kv = tildeParts[i].trim();
            if (!kv) continue;
            const colonIdx = kv.indexOf(':');
            if (colonIdx <= 0) continue;
            const key = kv.substring(0, colonIdx).trim();
            const value = kv.substring(colonIdx + 1).trim();
            if (!value) continue;
            
            // 关键词匹配
            if (/^(性别|gender|sex)$/i.test(key)) info.gender = value;
            else if (/^(年龄|age|年纪)$/i.test(key)) info.age = value;
            else if (/^(种族|race|族裔|族群)$/i.test(key)) info.race = value;
            else if (/^(职业|job|class|职务|身份)$/i.test(key)) info.job = value;
            else if (/^(补充|note|备注|其他)$/i.test(key)) info.note = value;
        }
        
        // 2. 解析主体
        let name = '';
        const pipeIdx = mainPart.indexOf('|');
        if (pipeIdx > 0) {
            name = mainPart.substring(0, pipeIdx).trim();
            const descPart = mainPart.substring(pipeIdx + 1).trim();
            
            const hasNewFormat = descPart.includes('=') || descPart.includes('@');
            
            if (hasNewFormat) {
                const atIdx = descPart.indexOf('@');
                let beforeAt = atIdx >= 0 ? descPart.substring(0, atIdx) : descPart;
                const relationship = atIdx >= 0 ? descPart.substring(atIdx + 1).trim() : '';
                
                const eqIdx = beforeAt.indexOf('=');
                const appearance = eqIdx >= 0 ? beforeAt.substring(0, eqIdx).trim() : beforeAt.trim();
                const personality = eqIdx >= 0 ? beforeAt.substring(eqIdx + 1).trim() : '';
                
                if (appearance) info.appearance = appearance;
                if (personality) info.personality = personality;
                if (relationship) info.relationship = relationship;
            } else {
                const parts = descPart.split('|').map(s => s.trim());
                if (parts[0]) info.appearance = parts[0];
                if (parts[1]) info.personality = parts[1];
                if (parts[2]) info.relationship = parts[2];
            }
        } else {
            name = mainPart.trim();
        }
        
        info._name = name;
        return info;
    }

    /**
     * 解析表格单元格数据
     * 格式: 每行一格 1,1:内容 或 单行多格用 | 分隔
     */
    _parseTableCellEntries(text) {
        const updates = {};
        if (!text) return updates;
        
        const cellRegex = /^(\d+)[,\-](\d+)[:：]\s*(.*)$/;
        
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            // 按 | 分割
            const segments = trimmed.split(/\s*[|｜]\s*/);
            
            for (const seg of segments) {
                const s = seg.trim();
                if (!s) continue;
                
                const m = s.match(cellRegex);
                if (m) {
                    const r = parseInt(m[1]);
                    const c = parseInt(m[2]);
                    const value = m[3].trim();
                    // 过滤空标记
                    if (value && !/^[\(\（]?空[\)\）]?$/.test(value) && !/^[-—]+$/.test(value)) {
                        updates[`${r}-${c}`] = value;
                    }
                }
            }
        }
        
        return updates;
    }

    /** 将表格更新写入 chat[0] */
    applyTableUpdates(tableUpdates) {
        if (!tableUpdates || tableUpdates.length === 0) return;
        
        const chat = this.getChat();
        if (!chat || chat.length === 0) return;
        
        const firstMsg = chat[0];
        if (!firstMsg.horae_meta) firstMsg.horae_meta = createEmptyMeta();
        if (!firstMsg.horae_meta.customTables) firstMsg.horae_meta.customTables = [];
        
        const tables = firstMsg.horae_meta.customTables;
        
        for (const update of tableUpdates) {
            // 查找对应表格
            const updateName = (update.name || '').trim();
            const table = tables.find(t => (t.name || '').trim() === updateName);
            if (!table) {
                console.warn(`[Horae] Bảng "${updateName}" không tồn tại (các bảng hiện có: ${tables.map(t => t.name).join(', ')}), bỏ qua`);
                continue;
            }
            
            if (!table.data) table.data = {};
            
            let updatedCount = 0;
            
            // 写入单元格，自动扩展，保护表头
            for (const [key, value] of Object.entries(update.updates)) {
                const [r, c] = key.split('-').map(Number);
                
                // 保护表头
                if (r === 0 || c === 0) {
                    const existing = table.data[key];
                    if (existing && existing.trim()) {
                        console.log(`[Horae] Bảng "${updateName}" bỏ qua ô tiêu đề [${r},${c}] (đã có: "${existing}")`);
                        continue;
                    }
                }
                
                table.data[key] = value;
                updatedCount++;
                
                if (r + 1 > (table.rows || 2)) table.rows = r + 1;
                if (c + 1 > (table.cols || 2)) table.cols = c + 1;
            }
            
            console.log(`[Horae] Bảng "${updateName}" đã cập nhật ${updatedCount} ô`);
        }
    }

    /** 重建表格数据（消息删除/编辑后保持一致性） */
    rebuildTableData() {
        const chat = this.getChat();
        if (!chat || chat.length === 0) return;
        
        const firstMsg = chat[0];
        if (!firstMsg.horae_meta?.customTables) return;
        
        const tables = firstMsg.horae_meta.customTables;
        
        // 1. 恢复到 baseData 快照
        for (const table of tables) {
            if (table.baseData) {
                table.data = JSON.parse(JSON.stringify(table.baseData));
            } else {
                // 无 baseData：清空数据区，保留表头
                if (!table.data) { table.data = {}; continue; }
                const keysToDelete = [];
                for (const key of Object.keys(table.data)) {
                    const [r, c] = key.split('-').map(Number);
                    if (r >= 1 && c >= 1) keysToDelete.push(key);
                }
                for (const key of keysToDelete) delete table.data[key];
            }
            
            if (table.baseRows !== undefined) {
                table.rows = table.baseRows;
            } else if (table.baseData) {
                // 无 baseRows，从 baseData 推算
                let calcRows = 2, calcCols = 2;
                for (const key of Object.keys(table.baseData)) {
                    const [r, c] = key.split('-').map(Number);
                    if (r === 0 && c + 1 > calcCols) calcCols = c + 1;
                    if (c === 0 && r + 1 > calcRows) calcRows = r + 1;
                }
                table.rows = calcRows;
                table.cols = calcCols;
            }
            if (table.baseCols !== undefined) {
                table.cols = table.baseCols;
            }
        }
        
        // 2. 按消息顺序回放 tableContributions
        let totalApplied = 0;
        for (let i = 0; i < chat.length; i++) {
            const meta = chat[i].horae_meta;
            if (meta?.tableContributions && meta.tableContributions.length > 0) {
                this.applyTableUpdates(meta.tableContributions);
                totalApplied++;
            }
        }
        
        console.log(`[Horae] Dữ liệu bảng đã được tái tạo, đã phát lại đóng góp bảng của ${totalApplied} tin nhắn`);
    }

    /** 扫描并注入历史记录 */
    async scanAndInjectHistory(progressCallback, analyzeCallback = null) {
        const chat = this.getChat();
        let processed = 0;
        let skipped = 0;

        for (let i = 0; i < chat.length; i++) {
            const message = chat[i];
            
            if (message.is_user) {
                skipped++;
                if (progressCallback) {
                    progressCallback(Math.round((i + 1) / chat.length * 100), i + 1, chat.length);
                }
                continue;
            }

            // 跳过已有元数据
            const hasEvents = message.horae_meta?.events?.length > 0 || message.horae_meta?.event?.summary;
            if (message.horae_meta && (
                message.horae_meta.timestamp?.story_date ||
                hasEvents ||
                Object.keys(message.horae_meta.costumes || {}).length > 0
            )) {
                skipped++;
                if (progressCallback) {
                    progressCallback(Math.round((i + 1) / chat.length * 100), i + 1, chat.length);
                }
                continue;
            }

            const parsed = this.parseHoraeTag(message.mes);
            
            if (parsed) {
                const meta = this.mergeParsedToMeta(null, parsed);
                // 记录表格贡献
                if (meta._tableUpdates) {
                    meta.tableContributions = meta._tableUpdates;
                    delete meta._tableUpdates;
                }
                this.setMessageMeta(i, meta);
                processed++;
            } else if (analyzeCallback) {
                try {
                    const analyzed = await analyzeCallback(message.mes);
                    if (analyzed) {
                        const meta = this.mergeParsedToMeta(null, analyzed);
                        if (meta._tableUpdates) {
                            meta.tableContributions = meta._tableUpdates;
                            delete meta._tableUpdates;
                        }
                        this.setMessageMeta(i, meta);
                        processed++;
                    }
                } catch (error) {
                    console.error(`[Horae] Phân tích tin nhắn #${i} thất bại:`, error);
                }
            } else {
                const meta = createEmptyMeta();
                this.setMessageMeta(i, meta);
                processed++;
            }

            if (progressCallback) {
                progressCallback(Math.round((i + 1) / chat.length * 100), i + 1, chat.length);
            }
        }

        return { processed, skipped };
    }

    /** 生成系统提示词附加内容 */
    generateSystemPromptAddition() {
        const userName = this.context?.name1 || 'Nhân vật chính';
        const charName = this.context?.name2 || 'Nhân vật';
        
        return `
【Horae记忆系统】（以下示例仅为示范，勿直接原句用于正文！）

═══ 核心原则：变化驱动 ═══
★★★ 在写<horae>标签前，先判断本回合哪些信息发生了实质变化 ★★★
  ① 场景基础（time/location/characters/costume）→ 每回合必填
  ② 其他所有字段 → 严格遵守各自的【触发条件】，无变化则完全不写该行
  ③ 已记录的NPC/物品若无新信息 → 禁止输出！重复输出无变化的数据=浪费token
  ④ 部分字段变化 → 使用增量更新，只写变化的部分

═══ 标签格式 ═══
每次回复末尾写两个标签：
<horae>
time:日期 时间（必填）
location:地点（必填）
atmosphere:氛围
characters:在场角色名,逗号分隔（必填）
costume:角色名=服装描述（必填，每人一行，禁止分号合并）
item/item!/item!!:见物品规则（触发时才写）
item-:物品名（物品消耗/丢失时删除。见物品规则，触发时才写）
affection:角色名=好感度（触发时才写）
npc:角色名|外貌=性格@关系~扩展字段（触发时才写）
agenda:日期|内容（新待办触发时才写）
agenda-:内容关键词（待办已完成/失效时才写，系统自动移除匹配的待办）
</horae>
<horaeevent>
event:重要程度|事件简述（30-50字，重要程度：一般/重要/关键，记录事件摘要，用于剧情追溯）
</horaeevent>

═══ 【物品】触发条件与规则 ═══
参照[物品清单]中的编号(#ID)，严格按以下条件决定是否输出。

【何时写】（满足任一条件才输出）
  ✦ 获得新物品 → item:/item!:/item!!:
  ✦ 已有物品的数量/归属/位置/性质发生改变 → item:（仅写变化部分）
  ✦ 物品消耗/丢失/用完 → item-:物品名
【何时不写】
  ✗ 物品无任何变化 → 禁止输出任何item行
  ✗ 物品仅被提及但无状态改变 → 不写

【格式】
  新获得：item:emoji物品名(数量)|描述=持有者@精确位置（可省略描述字段。除非该物品有特殊含意，如礼物、纪念品，则添加描述）
  新获得(重要)：item!:emoji物品名(数量)|描述=持有者@精确位置（重要物品，描述必填：外观+功能+来源）
  新获得(关键)：item!!:emoji物品名(数量)|描述=持有者@精确位置（关键道具，描述必须详细）
  已有物品变化：item:emoji物品名(新数量)=新持有者@新位置（仅更新变化的部分，不写|则保留原描述）
  消耗/丢失：item-:物品名

【字段级规则】
  · 描述：记录物品本质属性（外观/功能/来源），普通物品可省略，重要/关键物品首次必填
    ★ 外观特征（颜色、材质、大小等，便于后续一致性描写）
    ★ 功能/用途
    ★ 来源（谁给的/如何获得）
       - 示例（以下内容中若有示例仅为示范，勿直接原句用于正文！）：
         - 示例1：item!:🌹永生花束|深红色玫瑰永生花，黑色缎带束扎，艾伦赠送给莉莉的情人节礼物=莉莉@莉莉房间书桌上
         - 示例2：item!:🎫幸运十连抽券|闪着金光的纸质奖券，可在系统奖池进行一次十连抽的新手福利=莉莉丝@空间戒指
         - 示例3：item!!:🏧位面货币自动兑换机|看起来像个小型的ATM机，能按即时汇率兑换各位面货币=莉莉丝@酒馆吧台
  · 数量：单件不写(1)/(1个)/(1把)等，只有计量单位才写括号如(5斤)(1L)(1箱)
  · 位置：必须是精确固定地点
    ❌ 某某人身前地上、某某人脚边、某某人旁边、地板、桌子上
    ✅ 酒馆大厅地板、餐厅吧台上、家中厨房、背包里、莉莉丝的房间桌子上
  · 禁止将固定家具和建筑设施计入物品
  · 临时借用≠归属转移


示例（麦酒生命周期）：
  获得：item:🍺陈酿麦酒(50L)|杂物间翻出的麦酒，口感酸涩=莉莉丝@酒馆后厨食材柜
  量变：item:🍺陈酿麦酒(25L)=莉莉丝@酒馆后厨食材柜
  用完：item-:陈酿麦酒

═══ 【NPC】触发条件与规则 ═══
格式：npc:名|外貌=性格@与${userName}的关系~性别:值~年龄:值~种族:值~职业:值
分隔符：| 分名字，= 分外貌与性格，@ 分关系，~ 分扩展字段(key:value)

【何时写】（满足任一条件才输出该NPC的npc:行）
  ✦ 首次出场 → 完整格式，全部字段+全部~扩展字段（性别/年龄/种族/职业），缺一不可
  ✦ 外貌永久变化（如受伤留疤、换了发型、穿戴改变）→ 只写外貌字段
  ✦ 性格发生转变（如经历重大事件后性格改变）→ 只写性格字段
  ✦ 与${userName}的关系定位改变（如从客人变成朋友）→ 只写关系字段
  ✦ 获得关于该NPC的新信息（之前不知道的身高/体重等）→ 追加到对应字段
  ✦ ~扩展字段本身发生变化（如职业变了）→ 只写变化的~扩展字段
【何时不写】
  ✗ NPC在场但无新信息 → 禁止写npc:行
  ✗ NPC暂时离场后回来，信息无变化 → 禁止重写
  ✗ 想用同义词/缩写重写已有描述 → 严禁！
    ❌ "肌肉发达/满身战斗伤痕"→"肌肉强壮/伤疤"（换词≠更新）
    ✅ "肌肉发达/满身战斗伤痕/重伤"→"肌肉发达/满身战斗伤痕"（伤愈，移除过时状态）

【增量更新示例】（以NPC沃尔夫冈为例）
  首次：npc:沃尔夫冈|银灰狼兽人/身高220cm/满身战斗伤痕=沉默寡言的重装佣兵@${userName}的第一个客人~性别:男~年龄:约35~种族:狼兽人~职业:佣兵
  只更新关系：npc:沃尔夫冈|=@${userName}的男朋友
  只追加外貌：npc:沃尔夫冈|银灰狼兽人/身高220cm/满身战斗伤痕/左臂绷带
  只更新性格：npc:沃尔夫冈|=不再沉默/偶尔微笑
  只改职业：npc:沃尔夫冈|~职业:退役佣兵
（注意：未变化的字段和~扩展字段完全不写！系统自动保留原有数据！）

【关系描述规范】
  必须包含对象名且准确：❌客人 ✅${userName}的新访客 / ❌债主 ✅持有${userName}欠条的人 / ❌房东 ✅${userName}的房东 / ❌男朋友 ✅${userName}的男朋友 / ❌恩人 ✅救了${userName}一命的人 / ❌霸凌者 ✅欺负${userName}的人 / ❌暗恋者 ✅暗恋${userName}的人 / ❌仇人 ✅被${userName}杀掉了生父
  附属关系需写出所属NPC名：✅伊凡的猎犬; ${userName}客人的宠物 / 伊凡的女朋友; ${userName}的客人 / ${userName}的闺蜜; 伊凡的妻子 / ${userName}的继父; 伊凡的父亲 / ${userName}的情夫; 伊凡的弟弟 / ${userName}的闺蜜; ${userName}的丈夫的情妇; 插足${userName}与伊凡夫妻关系的第三者

═══ 【好感度】触发条件 ═══
仅记录NPC对${userName}的好感度（禁止记录${userName}自己）。每人一行，禁止数值后加注解。

【何时写】
  ✦ NPC首次出场 → 按关系判定初始值（陌生0-20/熟人30-50/朋友50-70/恋人70-90）
  ✦ 互动导致好感度实质变化 → affection:名=新总值
【何时不写】
  ✗ 好感度无变化 → 不写

═══ 【待办事项】触发条件 ═══
【何时写（新增）】
  ✦ 剧情中出现新的约定/计划/行程/任务/伏笔 → agenda:日期|内容
  格式：agenda:订立日期|内容（相对时间须括号标注绝对日期）
  示例：agenda:2026/02/10|艾伦邀请${userName}情人节晚上约会(2026/02/14 18:00)
【何时写（完成删除）】
  ✦ 待办事项已完成/已失效/已取消 → agenda-:内容关键词
  格式：agenda-:待办内容（写入已完成事项的内容关键词即可自动移除）
  示例：agenda-:艾伦邀请${userName}情人节晚上约会
【何时不写】
  ✗ 已有待办无变化 → 禁止每回合重复已有待办

═══ 时间格式规则 ═══
禁止"Day 1"/"第X天"等模糊格式，必须使用具体日历日期。
- 现代：年/月/日 时:分（如 2026/2/4 15:00）
- 历史：该年代日期（如 1920/3/15 14:00）
- 奇幻/架空：该世界观日历（如 霜降月第三日 黄昏）
${this.generateCustomTablesPrompt()}
`;
    }

    /** 生成自定义表格的提示词 */
    generateCustomTablesPrompt() {
        const chat = this.getChat();
        const firstMsg = chat?.[0];
        const customTables = firstMsg?.horae_meta?.customTables || this.settings?.customTables || [];
        if (customTables.length === 0) return '';
        
        let prompt = `
═══ 自定义表格规则 ═══
上方有用户自定义表格，根据"填写要求"填写数据。
★ 格式：<horaetable:表格名> 标签内，每行一个单元格 → 行,列:内容（坐标0起始，数据从1,1开始）
★★★ 核心原则：只记录剧情中实际发生的事！★★★
  - 标注"暂无数据"或"对应事件未发生"的列/行 → 绝对禁止填写！留空等事件发生！
  - 已有内容且无变化 → 不重复写
  - 空单元格无对应剧情 → 不填
  - 禁止输出"(空)""-""无"等占位符
`;
        
        for (const table of customTables) {
            const tableName = table.name || '自定义表格';
            prompt += `示例：
<horaetable:${tableName}>
1,1:数据A
2,1:数据B
</horaetable>
`;
            break;
        }
        
        return prompt;
    }

    /** 宽松正则解析（不需要标签包裹） */
    parseLooseFormat(message) {
        const result = {
            timestamp: {},
            costumes: {},
            items: {},
            deletedItems: [],
            events: [],  // 支持多个事件
            affection: {},
            npcs: {},
            scene: {},
            agenda: [],   // 待办事项
            deletedAgenda: []  // 已完成的待办事项
        };

        let hasAnyData = false;

        const patterns = {
            time: /time[:：]\s*(.+?)(?:\n|$)/gi,
            location: /location[:：]\s*(.+?)(?:\n|$)/gi,
            atmosphere: /atmosphere[:：]\s*(.+?)(?:\n|$)/gi,
            characters: /characters[:：]\s*(.+?)(?:\n|$)/gi,
            costume: /costume[:：]\s*(.+?)(?:\n|$)/gi,
            item: /item(!{0,2})[:：]\s*(.+?)(?:\n|$)/gi,
            itemDelete: /item-[:：]\s*(.+?)(?:\n|$)/gi,
            event: /event[:：]\s*(.+?)(?:\n|$)/gi,
            affection: /affection[:：]\s*(.+?)(?:\n|$)/gi,
            npc: /npc[:：]\s*(.+?)(?:\n|$)/gi,
            agendaDelete: /agenda-[:：]\s*(.+?)(?:\n|$)/gi,
            agenda: /agenda[:：]\s*(.+?)(?:\n|$)/gi
        };

        // time
        let match;
        while ((match = patterns.time.exec(message)) !== null) {
            const timeStr = match[1].trim();
            const clockMatch = timeStr.match(/\b(\d{1,2}:\d{2})\s*$/);
            if (clockMatch) {
                result.timestamp.story_time = clockMatch[1];
                result.timestamp.story_date = timeStr.substring(0, timeStr.lastIndexOf(clockMatch[1])).trim();
            } else {
                result.timestamp.story_date = timeStr;
                result.timestamp.story_time = '';
            }
            hasAnyData = true;
        }

        // location
        while ((match = patterns.location.exec(message)) !== null) {
            result.scene.location = match[1].trim();
            hasAnyData = true;
        }

        // atmosphere
        while ((match = patterns.atmosphere.exec(message)) !== null) {
            result.scene.atmosphere = match[1].trim();
            hasAnyData = true;
        }

        // characters
        while ((match = patterns.characters.exec(message)) !== null) {
            result.scene.characters_present = match[1].trim().split(/[,，]/).map(c => c.trim()).filter(Boolean);
            hasAnyData = true;
        }

        // costume
        while ((match = patterns.costume.exec(message)) !== null) {
            const costumeStr = match[1].trim();
            const eqIndex = costumeStr.indexOf('=');
            if (eqIndex > 0) {
                const char = costumeStr.substring(0, eqIndex).trim();
                const costume = costumeStr.substring(eqIndex + 1).trim();
                result.costumes[char] = costume;
                hasAnyData = true;
            }
        }

        // item
        while ((match = patterns.item.exec(message)) !== null) {
            const exclamations = match[1] || '';
            const itemStr = match[2].trim();
            let importance = '';  // 一般用空字符串
            if (exclamations === '!!') importance = '!!';  // 关键
            else if (exclamations === '!') importance = '!';  // 重要
            
            const eqIndex = itemStr.indexOf('=');
            if (eqIndex > 0) {
                let itemNamePart = itemStr.substring(0, eqIndex).trim();
                const rest = itemStr.substring(eqIndex + 1).trim();
                
                let icon = null;
                let itemName = itemNamePart;
                const emojiMatch = itemNamePart.match(/^([\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}])/u);
                if (emojiMatch) {
                    icon = emojiMatch[1];
                    itemName = itemNamePart.substring(icon.length).trim();
                }
                
                let description = undefined;  // undefined = 没有描述字段，合并时不覆盖原有描述
                const pipeIdx = itemName.indexOf('|');
                if (pipeIdx > 0) {
                    const descText = itemName.substring(pipeIdx + 1).trim();
                    if (descText) description = descText;  // 只有非空才设置
                    itemName = itemName.substring(0, pipeIdx).trim();
                }
                
                // 去掉无意义的数量标记
                itemName = itemName.replace(/[\(（]1[\)）]$/, '').trim();
                itemName = itemName.replace(new RegExp(`[\\(（]1[${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                itemName = itemName.replace(new RegExp(`[\\(（][${COUNTING_CLASSIFIERS}][\\)）]$`), '').trim();
                
                const atIndex = rest.indexOf('@');
                const itemInfo = {
                    icon: icon,
                    importance: importance,
                    holder: atIndex >= 0 ? (rest.substring(0, atIndex).trim() || null) : (rest || null),
                    location: atIndex >= 0 ? (rest.substring(atIndex + 1).trim() || '') : ''
                };
                if (description !== undefined) itemInfo.description = description;
                result.items[itemName] = itemInfo;
                hasAnyData = true;
            }
        }

        // item-
        while ((match = patterns.itemDelete.exec(message)) !== null) {
            const itemName = match[1].trim().replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, '').trim();
            if (itemName) {
                result.deletedItems.push(itemName);
                hasAnyData = true;
            }
        }

        // event
        while ((match = patterns.event.exec(message)) !== null) {
            const eventStr = match[1].trim();
            const parts = eventStr.split('|');
            if (parts.length >= 2) {
                const levelRaw = parts[0].trim();
                const summary = parts.slice(1).join('|').trim();
                
                let level = '一般';
                if (levelRaw === '关键' || levelRaw.toLowerCase() === 'critical') {
                    level = '关键';
                } else if (levelRaw === '重要' || levelRaw.toLowerCase() === 'important') {
                    level = '重要';
                }
                
                result.events.push({
                    is_important: level === '重要' || level === '关键',
                    level: level,
                    summary: summary
                });
                hasAnyData = true;
            }
        }

        // affection
        while ((match = patterns.affection.exec(message)) !== null) {
            const affStr = match[1].trim();
            // 绝对值格式
            const absMatch = affStr.match(/^(.+?)=\s*([+\-]?\d+)/);
            if (absMatch) {
                result.affection[absMatch[1].trim()] = { type: 'absolute', value: parseInt(absMatch[2]) };
                hasAnyData = true;
            } else {
                // 相对值格式 name+/-数值（无=号）
                const relMatch = affStr.match(/^(.+?)([+\-]\d+)/);
                if (relMatch) {
                    result.affection[relMatch[1].trim()] = { type: 'relative', value: relMatch[2] };
                    hasAnyData = true;
                }
            }
        }

        // npc
        while ((match = patterns.npc.exec(message)) !== null) {
            const npcStr = match[1].trim();
            const npcInfo = this._parseNpcFields(npcStr);
            const name = npcInfo._name;
            delete npcInfo._name;
            
            if (name) {
                npcInfo.last_seen = new Date().toISOString();
                result.npcs[name] = npcInfo;
                hasAnyData = true;
            }
        }

        // agenda-:（须在 agenda 之前解析）
        while ((match = patterns.agendaDelete.exec(message)) !== null) {
            const delStr = match[1].trim();
            if (delStr) {
                const pipeIdx = delStr.indexOf('|');
                const text = pipeIdx > 0 ? delStr.substring(pipeIdx + 1).trim() : delStr;
                if (text) {
                    result.deletedAgenda.push(text);
                    hasAnyData = true;
                }
            }
        }

        // agenda
        while ((match = patterns.agenda.exec(message)) !== null) {
            const agendaStr = match[1].trim();
            const pipeIdx = agendaStr.indexOf('|');
            if (pipeIdx > 0) {
                const dateStr = agendaStr.substring(0, pipeIdx).trim();
                const text = agendaStr.substring(pipeIdx + 1).trim();
                if (text) {
                    result.agenda.push({ date: dateStr, text, source: 'ai', done: false });
                    hasAnyData = true;
                }
            } else if (agendaStr) {
                result.agenda.push({ date: '', text: agendaStr, source: 'ai', done: false });
                hasAnyData = true;
            }
        }

        // 表格更新
        const tableMatches = [...message.matchAll(/<horaetable[:：]\s*(.+?)>([\s\S]*?)<\/horaetable>/gi)];
        if (tableMatches.length > 0) {
            result.tableUpdates = [];
            for (const tm of tableMatches) {
                const tableName = tm[1].trim();
                const tableContent = tm[2].trim();
                const updates = this._parseTableCellEntries(tableContent);
                
                if (Object.keys(updates).length > 0) {
                    result.tableUpdates.push({ name: tableName, updates });
                    hasAnyData = true;
                }
            }
        }

        return hasAnyData ? result : null;
    }
}

// 导出单例
export const horaeManager = new HoraeManager();
