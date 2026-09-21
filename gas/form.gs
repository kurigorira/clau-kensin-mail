/**
 * form.gs — サーバ側の入力検証
 * 2026-09-16 作成。関連：config.gs（選択肢の定義）／sheet.gs（受付可能日）／main.gs（doPost）
 *
 * 画面側のチェックは親切機能であって防御ではない。直接POSTされれば素通りする。
 * 台帳に入れてよいかどうかは、必ずここで判断する（CLAUDE.md「実装の方針」）。
 */

/** 選択肢の定義から1件取り出す。無ければ null。 */
function findOption_(value) {
  for (var i = 0; i < OPTION_LIST.length; i++) {
    if (OPTION_LIST[i].value === value) return OPTION_LIST[i];
  }
  return null;
}

/** 選んだ追加検査のどれかが、指定のフラグを持っているか。 */
function hasOptionFlag_(selectedOptions, flag) {
  for (var i = 0; i < selectedOptions.length; i++) {
    var option = findOption_(selectedOptions[i]);
    if (option && option[flag]) return true;
  }
  return false;
}

/**
 * 安全確認の項目を表示する（＝回答が必須になる）かどうか。
 * 画面側と同じ条件をここでも持つ。条件を変えるときは両方直すこと。
 */
function isSafetyRequired_(item, sex, selectedOptions) {
  if (item.show === 'always') return true;
  if (item.show === 'female') return sex === '女性';
  if (item.show === 'mr')     return hasOptionFlag_(selectedOptions, 'mr');
  if (item.show === 'ct')     return hasOptionFlag_(selectedOptions, 'ct');
  if (item.show === 'endo')   return hasOptionFlag_(selectedOptions, 'endo');
  return false;
}

/** 受診区分の定義を取り出す。 */
function findKubun_(value) {
  for (var i = 0; i < KUBUN_LIST.length; i++) {
    if (KUBUN_LIST[i].value === value) return KUBUN_LIST[i];
  }
  return null;
}

/** 一覧に含まれる値かどうか。改ざんされた選択肢を弾くために使う。 */
function isAllowedValue_(value, list) {
  return list.indexOf(value) !== -1;
}

function courseValues_() {
  return COURSE_LIST.map(function (course) { return course.value; });
}

/** 前後の空白を落として文字列にする。null/undefined も空文字にする。 */
function trimmed_(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * 申込内容を検証する。
 * 戻り値： { ok: true, data: {...} } または { ok: false, errors: [...], code: '...' }
 *
 * code は呼び出し側が分岐に使う。
 *   'validation'  … 入力の誤り。画面に項目名を出して直してもらう
 *   'slot_taken'  … 選んだ日が受付終了。選び直しを促す（docs/03 §4-5）
 *   'bot'         … 迷惑送信とみなした。画面には出さず黙って捨てる
 */
function validateApplication_(raw, availability) {
  var errors = [];
  raw = raw || {};

  // --- 迷惑送信対策（docs/01 F-08）---------------------------------
  // GAS では接続元 IP を取得できないため、IP 単位の制限は行えない。
  // 人には見えない欄に値が入っている、または表示から送信までが速すぎるものを弾く。
  if (trimmed_(raw[HONEYPOT_FIELD])) {
    return { ok: false, code: 'bot', errors: ['迷惑送信とみなしました。'] };
  }
  var elapsedSeconds = Number(raw.elapsed_seconds);
  if (!isNaN(elapsedSeconds) && elapsedSeconds >= 0 && elapsedSeconds < MIN_SUBMIT_SECONDS) {
    return { ok: false, code: 'bot', errors: ['迷惑送信とみなしました。'] };
  }

  // --- 受診区分と、区分ごとの追加項目 ------------------------------
  var kubun = trimmed_(raw.kubun);
  var kubunDef = findKubun_(kubun);
  if (!kubunDef) errors.push('お申し込みの区分をお選びください。');

  var extra = {};
  if (kubunDef) {
    for (var i = 0; i < kubunDef.extra.length; i++) {
      var field = kubunDef.extra[i];
      var value = trimmed_(raw['extra_' + field.key]);
      if (!value) {
        errors.push(field.label + 'をご入力ください。');
        continue;
      }
      if (field.type === 'select' && !isAllowedValue_(value, field.options)) {
        errors.push(field.label + 'の値が正しくありません。');
        continue;
      }
      extra[field.key] = value;
    }
  }

  // --- コース ------------------------------------------------------
  var course = trimmed_(raw.course);
  if (!isAllowedValue_(course, courseValues_())) {
    errors.push('ご希望のコースをお選びください。');
  }

  // --- 追加検査 ----------------------------------------------------
  var selectedOptions = [];
  var rawOptions = raw.options;
  if (typeof rawOptions === 'string') {
    rawOptions = rawOptions ? rawOptions.split(',') : [];
  }
  if (!Array.isArray(rawOptions)) rawOptions = [];

  for (var j = 0; j < rawOptions.length; j++) {
    var optionValue = trimmed_(rawOptions[j]);
    if (!optionValue) continue;
    if (!findOption_(optionValue)) {
      errors.push('追加の検査に、お選びいただけない項目が含まれています。');
      continue;
    }
    if (selectedOptions.indexOf(optionValue) === -1) selectedOptions.push(optionValue);
  }

  // 胃カメラと胃透視は同日に両方は実施しない想定（仮・未確認）。
  // 画面側でも排他にしているが、直接POSTされた場合はここで止める。
  var stomachCount = selectedOptions.filter(function (value) {
    var option = findOption_(value);
    return option && option.stomach;
  }).length;
  if (stomachCount > 1) {
    errors.push('胃の検査（胃カメラ・胃透視）は、どちらか一方をお選びください。');
  }

  // --- 鎮静剤（胃カメラを選んだときだけ聞く）------------------------
  var chinsei = trimmed_(raw.chinsei);
  var needsChinsei = hasOptionFlag_(selectedOptions, 'endo');
  if (needsChinsei) {
    if (!isAllowedValue_(chinsei, CHINSEI_LIST)) {
      errors.push('鎮静剤のご希望をお選びください。');
    }
  } else {
    chinsei = '';   // 表示されなかった項目は空欄にする
  }

  // --- ご本人について ----------------------------------------------
  var name = trimmed_(raw.name);
  if (!name) errors.push('お名前をご入力ください。');

  var kana = trimmed_(raw.kana);
  if (!kana) {
    errors.push('フリガナをご入力ください。');
  } else if (!/^[ァ-ヶー\s　]+$/.test(kana)) {
    errors.push('フリガナは全角カタカナでご入力ください。');
  }

  var birth = trimmed_(raw.birth);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) {
    errors.push('生年月日をご入力ください。');
  }

  var sex = trimmed_(raw.sex);
  if (!isAllowedValue_(sex, SEX_LIST)) errors.push('性別をお選びください。');

  var tel = trimmed_(raw.tel);
  if (!tel) {
    errors.push('電話番号をご入力ください。');
  } else if (!/^[0-9-]+$/.test(tel)) {
    errors.push('電話番号は数字とハイフンでご入力ください。');
  }

  var mail = trimmed_(raw.mail);
  if (!mail) {
    errors.push('メールアドレスをご入力ください。');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    errors.push('メールアドレスの形式をご確認ください。');
  }

  var jikan = trimmed_(raw.jikan);
  if (!isAllowedValue_(jikan, JIKAN_LIST)) errors.push('ご連絡しやすい時間帯をお選びください。');

  var rireki = trimmed_(raw.rireki);
  if (!isAllowedValue_(rireki, RIREKI_LIST)) errors.push('当院での健診の受診歴をお選びください。');

  // --- 希望日 ------------------------------------------------------
  var wishResult = validateWishes_(raw.wishes, availability);
  if (wishResult.code === 'slot_taken') {
    // 受付終了は入力ミスではないので、他のエラーより優先して伝える。
    return { ok: false, code: 'slot_taken', errors: wishResult.errors };
  }
  errors = errors.concat(wishResult.errors);

  // --- 安全確認 ----------------------------------------------------
  // 表示条件を満たす項目だけを必須にし、満たさない項目はキー自体を持たせない。
  var safety = {};
  for (var k = 0; k < SAFETY_LIST.length; k++) {
    var item = SAFETY_LIST[k];
    if (!isSafetyRequired_(item, sex, selectedOptions)) continue;
    var answer = trimmed_(raw['safety_' + item.key]);
    if (!isAllowedValue_(answer, item.options)) {
      errors.push('「' + item.label + '」にお答えください。');
      continue;
    }
    safety[item.key] = answer;
  }

  // --- 備考 --------------------------------------------------------
  var biko = trimmed_(raw.biko);
  if (biko.length > 150) errors.push('ご質問・ご要望は150文字以内でご入力ください。');

  if (errors.length) return { ok: false, code: 'validation', errors: errors };

  return {
    ok: true,
    data: {
      kubun: kubun, extra: extra,
      course: course, options: selectedOptions, chinsei: chinsei,
      name: name, kana: kana, birth: birth, sex: sex,
      tel: tel, mail: mail, jikan: jikan, rireki: rireki,
      wishes: wishResult.wishes,
      safety: safety, biko: biko,
      cal_generated_at: trimmed_(raw.cal_generated_at)
    }
  };
}

/**
 * 希望日を検証する。
 *
 * ここが省略されると、ページを開いたまま数時間放置して送信された場合に、
 * すでに受付を止めた日の依頼が入る（docs/03 §4-5）。送信の時点で必ず
 * 受付可能日データと突き合わせる。
 */
function validateWishes_(rawWishes, availability) {
  var errors = [];
  var wishes = [];
  var days = (availability && availability.days) ? availability.days : {};

  if (typeof rawWishes === 'string') {
    try {
      rawWishes = JSON.parse(rawWishes);
    } catch (error) {
      return { code: 'validation', errors: ['ご希望の日が正しく送信されませんでした。選び直してください。'], wishes: [] };
    }
  }
  if (!Array.isArray(rawWishes)) rawWishes = [];

  if (!rawWishes.length) {
    return { code: 'validation', errors: ['ご希望の日を1つ以上お選びください。'], wishes: [] };
  }
  if (rawWishes.length > WISH_MAX) {
    errors.push('ご希望の日は' + WISH_MAX + 'つまでです。');
    rawWishes = rawWishes.slice(0, WISH_MAX);
  }

  var closed = [];
  for (var i = 0; i < rawWishes.length; i++) {
    var date = trimmed_(rawWishes[i] && rawWishes[i].date);
    var slot = trimmed_(rawWishes[i] && rawWishes[i].slot);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isAllowedValue_(slot, SLOT_LIST)) {
      errors.push('ご希望の日が正しくありません。選び直してください。');
      continue;
    }
    // 同じ日時が2回入っていたら1つにまとめる
    var isDuplicate = wishes.some(function (wish) {
      return wish.date === date && wish.slot === slot;
    });
    if (isDuplicate) continue;

    var openSlots = days[date];
    if (!openSlots || openSlots.indexOf(slot) === -1) {
      closed.push(date + ' ' + slot);
      continue;
    }
    wishes.push({ date: date, slot: slot });
  }

  if (closed.length) {
    return {
      code: 'slot_taken',
      errors: ['選択された日は受付が終了しました。お手数ですが選び直してください。（' + closed.join('、') + '）'],
      wishes: []
    };
  }
  if (!wishes.length && !errors.length) {
    errors.push('ご希望の日を1つ以上お選びください。');
  }
  return { code: 'validation', errors: errors, wishes: wishes };
}
