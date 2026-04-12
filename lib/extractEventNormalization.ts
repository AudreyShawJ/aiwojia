/**
 * 抽取结果后处理：纠正 is_person / event_type，避免「人」的健康/财务被误标为 plant_pet；
 * 以及在 description 末尾追加「相对记录人（夫/妻）」的亲属说明，供全家读与主模型理解。
 */

export type MinimalExtractEvent = {
  title: string;
  description: string;
  event_type: string;
  related_member: string;
  is_person: boolean;
};

const KINSHIP_RE =
  /我爸|我妈|我爹|我娘|我哥|我姐|我弟|我妹|嫂子|姐夫|弟媳|妹夫|公婆|公公|婆婆|岳父|岳母|泰山|舅舅|姨妈|姑姑|叔叔|伯伯|堂兄|堂姐|表弟|表妹|外甥|侄子|侄女|孙子|外孙|妯娌|大伯|小叔|大姑|小姑|连襟|弟弟|哥哥|姐姐|妹妹|堂弟|堂哥|表姐|妈妈|父亲|爸爸(?!妈)/;

const HEALTH_RE =
  /妊娠|怀孕|孕|高血压|低血压|糖尿|糖尿病|控糖|胰岛素|肝炎|肝功|肾炎|肾|发炎|炎症|疼|痛|腰酸|腰疼|腰间盘|尿酸|血脂|胆固醇|心血管|心脏病|胸闷|心悸|中耳|声带|脱发|掉发|体检|挂号|复诊|手术|住院|出院|疫苗|感冒|发烧|咳嗽|医嘱|症状|不适|消炎|抗生素|药|病|耳鼻喉|特殊饮食|饮食管理/;

const FINANCE_RE =
  /还款|月供|房贷|车贷|信用卡|扣款|订阅|续费|会员费|DeepSeek|保费|买保险|购保|投保|新买.*保险|保险理赔|申请.*理赔|理赔|基金|理财|鲲鹏|存款|定存|活期|储蓄|银行|年费|滞纳|按揭|房租|物业费|水电|水费|电费|燃气费|网费|取暖费|车位费|学费|借呗|花呗|贷款|利息|工资|发工资|到账|副业|收入|年终奖|奖金|红包|分期|缴纳|交费|交款/;

const DAILY_GROOM_RE = /剪头发|理发|烫发|染发|美甲|洗头/;

/** 家务、取件、吃饭等生活琐事：显式标 daily，避免仅靠「去 plant_pet」兜底 */
const DAILY_LIFE_RE =
  /快递|包裹|取件|取.*包裹|吃饭|午餐|晚饭|晚餐|午饭|早饭|提醒吃|meal|生日|拖地|床单|收纳|餐巾纸|垃圾分类|插座|全屋插座|清洁.*空调|油烟机|帽子|衣物|搬.*家|去.*家吃饭/;

const HOUSE_RE = /保洁|家政|房产|房屋|物业维修|装修|换锁|防水/;

const PLANT_PET_RE =
  /猫|狗|犬|宠物|汪|喵|盆栽|绿植|多肉|浇花|花盆|花架|园艺|吊兰|绿萝|猫粮|狗粮|鱼缸|乌龟|仓鼠|兔|鹦鹉/;

const CHILD_RE = /儿子|女儿|孩子|宝宝|娃|身高|体重|成长|周岁|月龄/;

/**
 * 根据用户原话 + 模型输出纠偏分类，避免 related_member 为空就把「人」标成植物宠物。
 */
export function normalizeExtractedEventsForClassification<T extends MinimalExtractEvent>(
  userUtterance: string,
  events: T[]
): T[] {
  return events.map(e => normalizeOneEvent(userUtterance, e));
}

function normalizeOneEvent<T extends MinimalExtractEvent>(utterance: string, e: T): T {
  const blob = `${utterance || ''}${e.title || ''}${e.description || ''}`;
  const et = String(e.event_type || '').toLowerCase().trim();

  const kinship = KINSHIP_RE.test(blob);
  const health = HEALTH_RE.test(blob);
  const finance = FINANCE_RE.test(blob);
  const groom = DAILY_GROOM_RE.test(blob);
  const dailyLife = DAILY_LIFE_RE.test(blob);
  const house = HOUSE_RE.test(blob);
  const child = CHILD_RE.test(blob);
  const plantCue = PLANT_PET_RE.test(blob);

  const nonHumanStory =
    plantCue && !kinship && !health && !finance && !groom && !child && !dailyLife && !house;

  let isPerson = e.is_person !== false;
  let eventType = et;

  if (child) {
    isPerson = true;
    eventType = 'child';
  } else if (finance) {
    isPerson = true;
    eventType = 'finance';
  } else if (health) {
    isPerson = true;
    eventType = 'health';
  } else if (house) {
    isPerson = true;
    eventType = 'house';
  } else if (groom || dailyLife) {
    isPerson = true;
    eventType = 'daily';
  } else if (nonHumanStory && (e.is_person === false || et === 'plant_pet')) {
    isPerson = false;
    eventType = 'plant_pet';
  } else if (kinship) {
    isPerson = true;
    if (et === 'plant_pet' || e.is_person === false) {
      eventType = 'relationship';
    }
  } else if (et === 'plant_pet' || e.is_person === false) {
    if (nonHumanStory) {
      isPerson = false;
      eventType = 'plant_pet';
    } else {
      isPerson = true;
      eventType = et === 'plant_pet' ? 'daily' : e.event_type;
    }
  }

  if (isPerson && eventType === 'plant_pet') {
    eventType = 'daily';
  }

  return { ...e, is_person: isPerson, event_type: eventType };
}

/**
 * 在入库 description 末尾追加短注：说明称谓相对记录人（丈夫/妻子），避免其他家人误读。
 */
export function appendRecorderKinshipProvenanceLine(
  title: string,
  description: string,
  recorderRole: string | null
): string {
  const blob = `${title || ''}${description || ''}`;
  const r = recorderRole || '';
  const parts: string[] = [];

  if (/丈夫|老公|先生/.test(r)) {
    if (/嫂子|妯娌|大伯|小叔|大姑|小姑/.test(blob)) {
      parts.push(
        '「嫂子」等指记录人（丈夫）一方的姻亲/旁系；配偶侧应理解为「你爱人的嫂子」等，勿将当事人等同为配偶本人。'
      );
    }
    if (/我爸|我爹|我的父亲|我爸爸/.test(blob)) {
      parts.push('「我爸」等指记录人（丈夫）的生父一辈，勿与配偶父母（如妻子父亲、岳父）混淆。');
    }
    if (/我妈|我的母亲|我妈妈/.test(blob)) {
      parts.push('「我妈」等指记录人（丈夫）的生母一辈（对配偶常为婆婆），勿与配偶母亲（如妻子母亲、岳母）混淆。');
    }
  }
  if (/妻子|老婆|太太/.test(r)) {
    if (/我爸|我爹|我的父亲|我爸爸/.test(blob)) {
      parts.push('「我爸」等指记录人（妻子）的生父一辈；对配偶应换算为岳父等。');
    }
    if (/我妈|我的母亲|我妈妈/.test(blob)) {
      parts.push('「我妈」等指记录人（妻子）的生母一辈；对配偶应换算为岳母等。');
    }
    if (/公公|婆婆|婆家/.test(blob)) {
      parts.push('「公公/婆婆」为记录人（妻子）对配偶父母的称谓。');
    }
    if (/嫂子|姐夫|弟媳/.test(blob)) {
      parts.push('文中旁系姻亲以记录人（妻子）口语为准；对其他家人请结合成员表换算。');
    }
  }

  if (!parts.length) return description || '';

  const line = `〔亲属说明·便于全家阅读〕${parts.join(' ')}`;
  const base = (description || '').trim();
  if (base.includes('〔亲属说明')) return description || '';
  return base ? `${base}\n${line}` : line;
}
