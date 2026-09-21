/**
 * config.gs — 変わる値の集約
 * 2026-09-16 作成。関連：main.gs（エントリ）／sheet.gs（台帳）／mail.gs（メール）
 *
 * コース名・料金・オプション・宛先アドレスなど「あとで変わる値」は、
 * すべてこのファイルに置く。コードの中に直書きしない。
 * 改定のときはこのファイルだけ見ればよい状態を保つこと。
 */

// ===== スプレッドシート =====
// 台帳と受付可能日は同じファイル内の別シート（docs/03 §2）。
// ID は デプロイ時に実物の値へ差し替える。空のままだと sheet.gs が起動時に例外を投げる。
var SPREADSHEET_ID = '';                    // ←★デプロイ前に設定する
var SHEET_LEDGER   = '予約依頼台帳';
var SHEET_AVAIL    = '受付可能日';
var SHEET_ARCHIVE  = '過去分';              // 受付可能日の過去日を毎朝ここへ移す

// ===== メール =====
// docs/02 §1。送信元は病院ドメイン。SPF を通すこと。
var MAIL_TO_STAFF   = 'kenshin-uketsuke@nk-toku.jp';   // ←★確定したら差し替え（未決#9）
var MAIL_FROM_NAME  = '長崎北徳洲会病院 健康管理センター';
var MAIL_TO_SYSADMIN = 'joho-system@nk-toku.jp';       // ←★通知の宛先。確定したら差し替え

// ===== 施設情報（画面とメールの両方で使う） =====
var CENTER = {
  name:    '長崎北徳洲会病院　健康管理センター',
  tel:     '095-813-5820',
  fax:     '095-813-5821',
  hours:   '9:00〜16:30（月〜土）　日曜・祝日・年末年始は休みです',
  address: '〒851-2131 長崎県西彼杵郡長与町北陽台1丁目5番1'
};

// 折り返し連絡の目安（docs/01 未決#4）。自動返信の文面にも使う。
var CALLBACK_BUSINESS_DAYS = 2;

// ===== 受診区分（docs/02 表A） =====
// extra は区分を選んだときに追加で聞く項目。キー名は台帳 AE 列の JSON に入る。
var KUBUN_LIST = [
  {
    value: '個人（全額自己負担）',
    extra: [{ key: 'shiharai', label: 'お支払い方法', type: 'select',
              options: ['現金', 'クレジットカード', '未定'] }]
  },
  {
    value: '協会けんぽ 生活習慣病予防検診',
    extra: [{ key: 'hokensho', label: '保険証の記号・番号', type: 'text' },
            { key: 'fuyou',    label: 'ご家族（被扶養者）の同時受診', type: 'select',
              options: ['あり', 'なし'] }]
  },
  {
    value: '健康保険組合の補助を利用',
    extra: [{ key: 'kenpo',    label: '健康保険組合名', type: 'text' },
            { key: 'hojoken',  label: '補助券・受診券', type: 'select',
              options: ['あり', 'なし', '不明'] }]
  },
  {
    value: '自治体の特定健診・がん検診',
    extra: [{ key: 'shicho',    label: 'お住まいの市町名', type: 'text' },
            { key: 'jushinken', label: '受診券', type: 'select',
              options: ['あり', 'なし', '不明'] }]
  },
  { value: 'わからない', extra: [] }
];

// ===== コース（docs/02 表B） =====
// 出典：公式サイト course.php / price.php（2026-09-16 取得）。
// price が null の行は金額が一律に決まらないもの。price_note をそのまま画面に出す。
//
// 2026-09-16 変更：コース側の「胃部検査」分岐は廃止した。
// サイトでは胃カメラ・胃透視がオプション扱いで、コースごとの胃部検査の有無も
// ライト以外は確定できなかったため（詳細は docs/02 の変更注記）。
var COURSE_LIST = [
  { value: 'ライト（半日・胃カメラなし）', price: 27500, note: '半日。胃カメラは含みません' },
  { value: 'スタンダード（1日）',          price: 40700, note: '1日' },
  { value: 'プレミアム（1日）',            price: 51700, note: '1日' },
  { value: 'エグゼクティブ（1泊2日）',      price: 93500, note: '1泊2日' },
  { value: '脳ドック（半日）',              price: 53900, note: '半日' },
  { value: '定期健康診断A',                price:  8250, note: '法定健診' },
  { value: '定期健康診断B',                price:  3300, note: '法定健診' },
  { value: '生活習慣病予防健診',            price: 24200, note: '' },
  { value: '特定健診',   price: null, price_note: '加入している健康保険組合により異なります' },
  { value: 'がん検診',   price: null, price_note: '各市町村により異なります' },
  { value: '決めていない・相談したい', price: null, price_note: 'お電話で一緒に決めます' }
];

// ===== 追加検査（docs/02 表C） =====
// 出典：公式サイト option.php（2026-09-16 取得）。
// フラグの意味：
//   mr      … 体内金属・ペースメーカーを確認する（MR のみ。CT では聞かない）
//   ct      … 造影剤アレルギーを確認する対象（造影の要否は未確認・仮）
//   endo    … 胃カメラ。鎮静剤と抗血栓薬を確認する
//   stomach … 胃の検査。同日に複数は実施しない想定のため排他にする（仮）
//   colon   … 別日に再来院が必要（course.php に明記）
//   fujinka … 乳腺・婦人科。水 10-12／金 14-16 のみ実施（course.php に明記）
var OPTION_LIST = [
  { value: '腹部エコー',              price:  6050 },
  { value: '心臓エコー',              price:  9900 },
  { value: '頭部MR',                  price: 22000, mr: true, ct: true },
  { value: 'AI脳解析用MR+CQテスト',    price: 38500, mr: true, ct: true },
  { value: '頭部CT',                  price: 11000, ct: true },
  { value: '胃カメラ',                price: 13200, endo: true, stomach: true },
  { value: '大腸カメラ',              price: 17600, colon: true },
  { value: '胃透視',                  price: 11000, stomach: true },
  { value: 'ペプシノゲン',            price:  3300 },
  { value: '子宮頸部',                price:  3850, fujinka: true },
  { value: 'マンモグラフィー',        price:  6050, fujinka: true },
  { value: '乳房エコー',              price:  5500, fujinka: true }
];

// 料金の表示に添える注記。改定があるため、いつ時点かを必ず画面に出す。
var PRICE_AS_OF = '2026-09-16';

// ===== 安全確認（docs/01 §6.1 E） =====
// 回答は3択のみ。病名・薬剤名・症状は取得しない（CLAUDE.md「個人情報の扱い」）。
// show は表示条件。form.gs のサーバ側検証でも同じ条件を使う。
var YES_NO_UNKNOWN = ['該当あり', '該当なし', 'わからない'];
var SAFETY_LIST = [
  { key: 'ninshin', label: '妊娠中・妊娠の可能性・授乳中',        show: 'female', options: YES_NO_UNKNOWN },
  { key: 'kinzoku', label: 'ペースメーカー・体内の金属・刺青',     show: 'mr',     options: YES_NO_UNKNOWN },
  { key: 'zoei',    label: '造影剤でアレルギーが出たことがある',   show: 'ct',     options: YES_NO_UNKNOWN },
  { key: 'kessen',  label: '血をサラサラにするお薬を飲んでいる',   show: 'endo',   options: YES_NO_UNKNOWN },
  { key: 'kaijo',   label: '車いすのご利用・介助が必要',           show: 'always', options: ['必要', '不要', 'わからない'] },
  { key: 'netsu',   label: '受診日から2週間以内に発熱・咳などの症状', show: 'always', options: YES_NO_UNKNOWN }
];

// 台帳で色を付ける回答（docs/01 付録B の条件付き書式）。
var SAFETY_FLAG_VALUES = ['該当あり', 'わからない', '必要'];

// ===== その他の選択肢 =====
var SEX_LIST     = ['男性', '女性'];
var JIKAN_LIST   = ['午前', '午後', '夕方以降', 'いつでも'];  // 連絡希望時間帯
var RIREKI_LIST  = ['初めて', '2回目以降'];
var CHINSEI_LIST = ['希望する', '希望しない', '相談したい'];
var SLOT_LIST    = ['午前', '午後'];                          // 受付可能日の時間帯
var WISH_MAX     = 3;                                         // 希望日は最大3件（docs/03 §4）

// ===== 台帳の列 =====
// 左端 A〜F が運用列（受付担当が更新する）。G 以降は GAS が書き、手で編集しない。
// 右へスクロールしないと仕事にならない並びにすると使われなくなるため、
// 運用列を必ず左端に置く（docs/01 付録B）。
//
// 2026-09-16 変更点：
//  - 旧 V「胃部検査」列は廃止（胃カメラ・胃透視は X 追加検査に入る）
//  - 旧 AF「送信元IP」列は廃止。GAS の doPost では接続元 IP を取得できないため
//    （docs/01 のリスク欄にある「同一IPからの連続送信の制限」も GAS では実装不可）
//  - 第3希望に時間帯の列が無く左右非対称だったので、T を第3希望時間帯にして揃えた
var LEDGER_COLUMNS = [
  '受付番号', '受付日時', 'ステータス', '対応担当', '確定日時', '確定コース',   // A-F 運用列
  '氏名', 'フリガナ', '生年月日', '性別', '電話番号', 'メールアドレス',          // G-L
  '連絡希望時間帯', '受診歴',                                                  // M-N
  '第1希望日', '第1希望時間帯', '第2希望日', '第2希望時間帯',                    // O-R
  '第3希望日', '第3希望時間帯',                                                // S-T
  '受診区分', '希望コース', '鎮静剤希望', '追加検査',                            // U-X
  '妊娠等', '体内金属', '造影剤', '抗血栓薬', '車いす・介助', '2週間以内の発熱',   // Y-AD
  '区分別の追加項目', '備考', '受付可能日データ生成時刻', '起票日時'              // AE-AH
];
var LEDGER_OPERATION_COLUMN_COUNT = 6;   // A〜F。ここまでが受付担当の編集範囲

// ステータス（docs/01 付録B）。台帳のプルダウンにもこの順で入れる。
var STATUS_LIST = ['未対応', '連絡中', '予約確定', 'キャンセル', '不成立'];
var STATUS_INITIAL = '未対応';

// ===== 受付可能日の通知（docs/03 §5） =====
// このカレンダーは更新が止まった瞬間にフォーム全体が使えなくなる。
// 気づく仕組みが無いと、申し込みがゼロになった理由が誰にも分からない。
var AVAIL_MIN_DAYS   = 7;   // 選択可能日がこれを下回ったら通知
var AVAIL_STALE_DAYS = 3;   // 最終更新からこの日数が経ったら通知

// ===== 保持期間 =====
// 2026-09-16 のクラウド利用承認に付いた条件。1年は「上限」であって目安ではない。
// 放置すると承認条件違反になるため、notify.gs の時間主導トリガーで退避と削除を行う。
var RETENTION_DAYS = 365;

// ===== 迷惑送信対策（docs/01 F-08） =====
// GAS では接続元 IP を取得できないため、IP 単位の制限は実装できない。
// ハニーポット（人には見えない入力欄）と、表示から送信までの経過秒で判定する。
var HONEYPOT_FIELD = 'fax_number';   // 人は入力しない欄。値が入っていれば bot
var MIN_SUBMIT_SECONDS = 5;          // これより速い送信は bot とみなす

// ===== 受付停止（docs/01 F-11） =====
// 年末年始などに画面から申し込みを止めるためのフラグ。
var IS_SUSPENDED = false;
var SUSPENDED_MESSAGE = 'ただいまインターネットでのお申し込みを停止しています。お手数ですが、お電話でお申し込みください。';
