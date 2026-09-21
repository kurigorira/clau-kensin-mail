/**
 * mail.gs — 受付担当への通知と、申込者への自動返信
 * 2026-09-16 作成。関連：config.gs（宛先・施設情報）／docs/02_メール仕様.md
 *
 * 差出人は、このスクリプトを実行する Google アカウントになる。
 * クラウド利用の承認条件として Workspace 契約が前提のため、病院ドメインの
 * アカウントで運用すれば送信元も病院ドメインになる（SPF は事前に確認すること）。
 */

/**
 * 受付担当へ通知する。
 * 前半は人が読む整形テキスト、後半に機械可読ブロックを置く（docs/02 §1）。
 *
 * 案D では台帳へ直接書き込むので、このブロックを解析して起票することはない。
 * それでも残すのは、案Bへ切り戻す場合の仕様であり、かつ台帳が壊れたときに
 * メールから復旧できる控えになるため。
 */
function sendStaffMail_(receiptNo, data) {
  var subject = '【健診予約依頼】' + receiptNo + ' ' + data.name + ' / ' + data.course;
  var body = buildStaffMailBody_(receiptNo, data);

  MailApp.sendEmail({
    to: MAIL_TO_STAFF,
    subject: subject,
    body: body,
    name: MAIL_FROM_NAME,
    replyTo: data.mail      // 受付担当がそのまま返信できるようにする
  });
}

function buildStaffMailBody_(receiptNo, data) {
  var lines = [];
  lines.push('予約の依頼を受け付けました。折り返しお電話をお願いします。');
  lines.push('');
  lines.push('受付番号：' + receiptNo);
  lines.push('受付日時：' + nowStamp_());
  lines.push('');

  lines.push('■ 連絡先');
  lines.push('　お名前　　：' + data.name + '（' + data.kana + '）');
  lines.push('　生年月日　：' + data.birth + '（' + calcAge_(data.birth) + '歳）／' + data.sex);
  lines.push('　電話　　　：' + data.tel);
  lines.push('　メール　　：' + data.mail);
  lines.push('　連絡希望　：' + data.jikan);
  lines.push('　受診歴　　：' + data.rireki);
  lines.push('');

  lines.push('■ ご希望');
  lines.push('　区分　　　：' + data.kubun + formatExtra_(data.extra));
  lines.push('　コース　　：' + data.course + formatPrice_(findCourse_(data.course)));
  lines.push('　追加検査　：' + (data.options.length ? formatOptions_(data.options) : 'なし'));
  if (data.chinsei) {
    lines.push('　鎮静剤　　：' + data.chinsei +
      (data.chinsei === '希望する' ? '　★当日の運転不可を案内済み' : ''));
  }
  if (hasOptionFlag_(data.options, 'colon')) {
    lines.push('　　※ 大腸カメラのため別日の再来院が必要です');
  }
  if (hasOptionFlag_(data.options, 'fujinka')) {
    lines.push('　　※ 乳腺・婦人科は水10:00-12:00／金14:00-16:00のみ実施');
  }
  lines.push('');

  lines.push('■ 希望日');
  for (var i = 0; i < WISH_MAX; i++) {
    var wish = data.wishes[i];
    lines.push('　第' + (i + 1) + '希望　：' + (wish ? wish.date + ' ' + wish.slot : '（未選択）'));
  }
  lines.push('');

  lines.push('■ 安全確認（電話で必ず確認してください）');
  for (var j = 0; j < SAFETY_LIST.length; j++) {
    var item = SAFETY_LIST[j];
    if (!Object.prototype.hasOwnProperty.call(data.safety, item.key)) continue;
    var answer = data.safety[item.key];
    // 「該当あり」「わからない」「必要」は電話で必ず確認する項目なので目印を付ける
    var flag = SAFETY_FLAG_VALUES.indexOf(answer) !== -1 ? '　★要確認' : '';
    lines.push('　' + item.label + '：' + answer + flag);
  }
  lines.push('');

  lines.push('■ ご質問・ご要望');
  lines.push('　' + (data.biko || '（なし）'));
  lines.push('');

  lines.push('========== 以下はシステム処理用（編集しないでください） ==========');
  lines.push('#DATA_BEGIN');
  lines.push(JSON.stringify(buildMachineBlock_(receiptNo, data)));
  lines.push('#DATA_END');

  return lines.join('\n');
}

/**
 * 機械可読ブロックの中身（docs/02 §2）。
 * 表示されなかった項目はキー自体を出さない。台帳側で「未表示」と「未入力」を
 * 区別するため、空文字での出力はしない。
 *
 * 2026-09-16 変更：胃の検査をオプションに一本化したため igi キーは廃止した。
 * 胃カメラ・胃透視は option 配列に入る。
 */
function buildMachineBlock_(receiptNo, data) {
  var block = {
    uketsuke_no: receiptNo,
    uketsuke_at: nowStamp_(),
    kubun: data.kubun,
    course: data.course,
    name: data.name,
    kana: data.kana,
    birth: data.birth,
    sex: data.sex,
    tel: data.tel,
    mail: data.mail,
    jikan: data.jikan,
    rireki: data.rireki,
    d1: wishValue_(data.wishes, 0, 'date'),
    t1: wishValue_(data.wishes, 0, 'slot'),
    d2: wishValue_(data.wishes, 1, 'date'),
    t2: wishValue_(data.wishes, 1, 'slot'),
    d3: wishValue_(data.wishes, 2, 'date'),
    t3: wishValue_(data.wishes, 2, 'slot'),
    cal_generated_at: data.cal_generated_at || '',
    option: data.options,
    biko: data.biko || ''
  };

  // 区分によって出す項目
  for (var key in data.extra) {
    if (Object.prototype.hasOwnProperty.call(data.extra, key)) block[key] = data.extra[key];
  }
  // 条件を満たしたときだけ出す項目
  if (data.chinsei) block.chinsei = data.chinsei;
  for (var safetyKey in data.safety) {
    if (Object.prototype.hasOwnProperty.call(data.safety, safetyKey)) {
      block[safetyKey] = data.safety[safetyKey];
    }
  }
  return block;
}

/**
 * 申込者へ自動返信する。
 *
 * 含めてはいけないもの（docs/02 §3・CLAUDE.md）：
 *   安全確認の回答、保険証の記号・番号、生年月日。
 * 家族共用のメールアドレスに届く場合を想定している。
 * 文面に生年月日が無いのは省略ではなく仕様。
 */
function sendApplicantMail_(receiptNo, data) {
  var subject = '【長崎北徳洲会病院】健診の予約依頼を受け付けました（' + receiptNo + '）';
  var lines = [];

  lines.push(data.name + ' 様');
  lines.push('');
  lines.push('予約のご依頼を受け付けました。');
  lines.push('このメールは受付の確認であり、予約はまだ確定していません。');
  lines.push(CALLBACK_BUSINESS_DAYS + '営業日以内（日曜・祝日を除く）に、担当者からお電話いたします。');
  lines.push('');
  lines.push('　受付番号　：' + receiptNo);
  lines.push('　受付日時　：' + nowStamp_());
  lines.push('　ご希望コース：' + data.course);
  for (var i = 0; i < data.wishes.length; i++) {
    lines.push('　第' + (i + 1) + '希望　：' + data.wishes[i].date + ' ' + data.wishes[i].slot);
  }
  lines.push('');

  if (hasOptionFlag_(data.options, 'colon')) {
    lines.push('※ 大腸カメラをご希望の方は、健診とは別日に再度ご来院いただきます。');
    lines.push('　 日程はお電話で調整します。');
    lines.push('');
  }
  if (data.chinsei === '希望する') {
    lines.push('※ 鎮静剤を使用した場合、当日はお車・バイク・自転車でお帰りいただけません。');
    lines.push('　 公共交通機関をご利用になるか、ご家族の送迎をご手配ください。');
    lines.push('');
  }

  lines.push((CALLBACK_BUSINESS_DAYS + 1) + '営業日を過ぎても連絡がない場合は、お手数ですが');
  lines.push('健康管理センター（' + CENTER.tel + '）までお電話ください。');
  lines.push('');
  lines.push(CENTER.name);
  lines.push('電話 ' + CENTER.tel + '（直通）／FAX ' + CENTER.fax);
  lines.push('電話受付 ' + CENTER.hours);
  lines.push(CENTER.address);
  lines.push('');
  lines.push('※このメールは送信専用です。ご返信いただいてもお答えできません。');

  MailApp.sendEmail({
    to: data.mail,
    subject: subject,
    body: lines.join('\n'),
    name: MAIL_FROM_NAME
    // replyTo は設定しない。送信専用のため（docs/02 §3）
  });
}

// ===== 小さな補助 ===================================================

function nowStamp_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
}

function wishValue_(wishes, index, key) {
  var wish = wishes[index];
  return wish ? wish[key] : '';
}

function findCourse_(value) {
  for (var i = 0; i < COURSE_LIST.length; i++) {
    if (COURSE_LIST[i].value === value) return COURSE_LIST[i];
  }
  return null;
}

/** 料金を「　￥40,700」の形にする。金額が一律でないコースは注記をそのまま出す。 */
function formatPrice_(item) {
  if (!item) return '';
  if (item.price) return '　￥' + formatNumber_(item.price);
  if (item.price_note) return '　' + item.price_note;
  return '';
}

function formatOptions_(values) {
  return values.map(function (value) {
    var option = findOption_(value);
    return value + (option && option.price ? '（￥' + formatNumber_(option.price) + '）' : '');
  }).join('、');
}

/** 40700 → '40,700' */
function formatNumber_(number) {
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 区分ごとの追加項目を「（○○健康保険組合／補助券あり）」の形にする。 */
function formatExtra_(extra) {
  var values = [];
  for (var key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) values.push(extra[key]);
  }
  return values.length ? '（' + values.join('／') + '）' : '';
}

/** 受付担当が電話前に年齢を把握できるようにする。誕生日前かどうかまで見る。 */
function calcAge_(birth) {
  var parts = String(birth).split('-');
  if (parts.length !== 3) return '—';
  var birthDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var today = new Date();
  var age = today.getFullYear() - birthDate.getFullYear();
  var monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age--;
  return age;
}
