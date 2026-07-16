// 數A 核心變式題庫
// 固定公式產生、可重算驗證；不使用生成式 AI 當答案來源。
// 同模板共用 grp，單輪只出一個數字變式，跨輪再抽其他變式。
'use strict';

(() => {
  const out = [];
  const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; };
  const frac = (n, d) => { const g = gcd(n, d); n /= g; d /= g; return d === 1 ? String(n) : `${n}/${d}`; };
  const add = (topic, family, i, diff, target, q, ans, sol, tip) => out.push({
    id: `core-${topic}-${family}-${i + 1}`, grp: `core-${topic}-${family}`,
    src: '核心變式題庫', rev: 1, topic, diff, type: 'fill', target,
    q, ans: (Array.isArray(ans) ? ans : [ans]).map(String), sol, tip,
  });
  const sign = (n) => n >= 0 ? `+${n}` : String(n);

  for (let i = 0; i < 10; i++) {
    const a = i - 4, r = i + 3, k = i + 3;
    add('num', 'abs', i, 1, 55, `不等式 \\(|x${sign(-a)}|<${r}\\) 的整數解共有幾個？`, 2 * r - 1,
      `化為 \\(${a - r}<x<${a + r}\\)，端點不取，共 \\(${2 * r - 1}\\) 個整數。`, '先拆成雙邊不等式，再數整數。');
    add('num', 'symmetric', i, 2, 100, `已知 \\(x+\\frac1x=${k}\\)，求 \\(x^3+\\frac1{x^3}\\)。`, k ** 3 - 3 * k,
      `利用 \\((x+\\frac1x)^3=x^3+\\frac1{x^3}+3(x+\\frac1x)\\)，答案為 \\(${k}^3-3(${k})=${k ** 3 - 3 * k}\\)。`, '三次對稱式固定用 k³−3k。');
  }

  for (let i = 0; i < 10; i++) {
    const x = i - 3, y = 2 * i - 5, dx = i + 2, m = (i % 5) - 2 || 3;
    add('line', 'slope', i, 1, 55, `通過 \\(( ${x},${y})\\) 與 \\(( ${x + dx},${y + m * dx})\\) 的直線斜率為何？`, m,
      `\\(m=\\frac{\\Delta y}{\\Delta x}=\\frac{${m * dx}}{${dx}}=${m}\\)。`, '分子分母必須用同一個點的順序相減。');
    const d = i + 1, c = 5 * d - 3 * x - 4 * y;
    add('line', 'distance', i, 2, 90, `點 \\(( ${x},${y})\\) 到直線 \\(3x+4y${sign(c)}=0\\) 的距離為何？`, d,
      `距離 \\(=\\frac{|3(${x})+4(${y})${sign(c)}|}{\\sqrt{3^2+4^2}}=\\frac{${5 * d}}5=${d}\\)。`, '先整理成 ax+by+c=0 再套距離公式。');
  }

  for (let i = 0; i < 10; i++) {
    const A = i % 3 + 1, b = i - 5, c = 2 * i - 3, t = i % 5 - 2, rem = A * t * t + b * t + c;
    add('poly', 'remainder', i, 1, 70, `\\(f(x)=${A}x^2${sign(b)}x${sign(c)}\\)，求 \\(f(${t})\\)。`, rem,
      `依餘式定理直接代入：\\(f(${t})=${rem}\\)。`, '除以 x−a 的餘式就是 f(a)。');
    const h = i - 4, vb = -2 * h;
    add('poly', 'vertex', i, 2, 85, `拋物線 \\(y=x^2${sign(vb)}x${sign(c)}\\) 的對稱軸為 \\(x=\\) 多少？`, h,
      `\\(x=-\\frac{b}{2a}=-\\frac{${vb}}2=${h}\\)。`, '二次函數先抓對稱軸 −b/(2a)。');
  }

  for (let i = 0; i < 10; i++) {
    const a = i + 1, d = i % 4 + 1, n = i + 5, an = a + (n - 1) * d;
    add('seq', 'arithmetic', i, 1, 60, `等差數列首項 \\(${a}\\)、公差 \\(${d}\\)，求第 \\(${n}\\) 項。`, an,
      `\\(a_n=a_1+(n-1)d=${a}+${n - 1}(${d})=${an}\\)。`, '第 n 項只走 n−1 次公差。');
    const g = i % 3 + 1, ratio = i % 2 + 2, gn = i % 4 + 3, sum = g * (ratio ** gn - 1) / (ratio - 1);
    add('seq', 'geometric-sum', i, 2, 100, `等比數列首項 \\(${g}\\)、公比 \\(${ratio}\\)，求前 \\(${gn}\\) 項和。`, sum,
      `\\(S_n=a_1\\frac{r^n-1}{r-1}=${g}\\frac{${ratio}^{${gn}}-1}{${ratio}-1}=${sum}\\)。`, '先辨認公比，再套等比和公式。');
  }

  for (let i = 0; i < 10; i++) {
    const n = i + 5, c2 = n * (n - 1) / 2, p3 = n * (n - 1) * (n - 2);
    add('comb', 'choose-two', i, 1, 55, `從 \\(${n}\\) 人中選 \\(2\\) 人，不計順序，共有幾種？`, c2,
      `用組合：\\(C^{${n}}_2=\\frac{${n}(${n - 1})}2=${c2}\\)。`, '不排職位、不計順序，用組合。');
    add('comb', 'perm-three', i, 2, 70, `從 \\(${n}\\) 人中選 \\(3\\) 人依序站成一排，共有幾種？`, p3,
      `順序不同算不同，\\(P^{${n}}_3=${n}(${n - 1})(${n - 2})=${p3}\\)。`, '有位置或次序就用排列。');
  }

  for (let i = 0; i < 10; i++) {
    const coins = i + 2, pow = 2 ** coins;
    add('prob', 'at-least-one', i, 1, 65, `同時擲 \\(${coins}\\) 枚公平硬幣，至少出現一個正面的機率為何？`, frac(pow - 1, pow),
      `用補事件：\\(1-P(全反面)=1-(\\frac12)^{${coins}}=${frac(pow - 1, pow)}\\)。`, '至少一個，先算一個都沒有。');
    const red = i + 3, blue = i % 4 + 2, total = red + blue;
    add('prob', 'without-replace', i, 2, 95, `袋中有 \\(${red}\\) 顆紅球、\\(${blue}\\) 顆藍球，不放回抽兩顆，兩顆皆紅的機率為何？`, frac(red * (red - 1), total * (total - 1)),
      `\\(\\frac{${red}}{${total}}\\cdot\\frac{${red - 1}}{${total - 1}}=${frac(red * (red - 1), total * (total - 1))}\\)。`, '無放回時第二次的分子、分母都少一。');
  }

  for (let i = 0; i < 10; i++) {
    const m = 3 * i + 10;
    add('data', 'mean', i, 1, 50, `五筆資料為 \\(${m - 2},${m - 1},${m},${m + 1},${m + 2}\\)，平均數為何？`, m,
      `資料以 \\(${m}\\) 為中心對稱，偏差互相抵消，所以平均數是 \\(${m}\\)。`, '對稱資料的中心就是平均。');
    const mean = 5 * i + 30, sd = i % 4 + 2, z = i % 5 - 2, x = mean + sd * z;
    add('data', 'z-score', i, 2, 70, `某數值為 \\(${x}\\)，平均數 \\(${mean}\\)、標準差 \\(${sd}\\)，其標準分數 \\(z\\) 為何？`, z,
      `\\(z=\\frac{x-\\mu}{\\sigma}=\\frac{${x}-${mean}}{${sd}}=${z}\\)。`, '先減平均，再除以標準差。');
  }

  const triples = [[3, 4, 5], [5, 12, 13], [8, 15, 17], [7, 24, 25], [9, 12, 15]];
  for (let i = 0; i < 10; i++) {
    const base = triples[i % triples.length], scale = Math.floor(i / triples.length) + 1;
    const [opp, adj, hyp] = base.map((x) => x * scale);
    add('trig1', 'right-sin', i, 1, 55, `直角三角形某銳角的對邊、鄰邊、斜邊依序為 \\(${opp},${adj},${hyp}\\)，求此角的 \\(\\sin\\)。`, frac(opp, hyp),
      `\\(\\sin=\\frac{對邊}{斜邊}=\\frac{${opp}}{${hyp}}=${frac(opp, hyp)}\\)。`, 'SOH：sin＝對邊／斜邊。');
    const a = 2 * (i + 2), b = 2 * (i + 3), area = a * b / 4;
    add('trig1', 'area', i, 2, 75, `三角形兩邊長為 \\(${a},${b}\\)，夾角 \\(30^\\circ\\)，面積為何？`, area,
      `\\(面積=\\frac12ab\\sin30^\\circ=\\frac12(${a})(${b})\\frac12=${area}\\)。`, '兩邊夾角求面積，用 1/2 ab sin C。');
  }

  const special = [[30, '1/2'], [45, '√2/2'], [60, '√3/2'], [150, '1/2'], [210, '-1/2']];
  for (let i = 0; i < 10; i++) {
    const [baseAngle, val] = special[i % special.length], angle = baseAngle + 360 * Math.floor(i / special.length);
    add('trig2', 'special', i, 1, 45, `求 \\(\\sin ${angle}^\\circ\\) 的值。`, [val, val.replace('-', '−')],
      `先化到一圈內，\\(\\sin ${angle}^\\circ=${val}\\)。`, '先判象限正負，再套 30、45、60 度基本值。');
    const A = (i % 2 ? -1 : 1) * (i + 2), c = i - 3;
    add('trig2', 'maximum', i, 1, 55, `函數 \\(y=${A}\\sin x${sign(c)}\\) 的最大值為何？`, Math.abs(A) + c,
      `振幅為 \\(${Math.abs(A)}\\)，中線為 \\(${c}\\)，最大值 \\(${Math.abs(A)}${sign(c)}=${Math.abs(A) + c}\\)。`, '最大值＝中線高度＋振幅。');
  }

  for (let i = 0; i < 10; i++) {
    const b = i % 4 + 2, k = i + 2;
    add('exp', 'log-power', i, 1, 45, `求 \\(\\log_{${b}} ${b ** k}\\)。`, k,
      `因 \\(${b}^{${k}}=${b ** k}\\)，依定義答案為 \\(${k}\\)。`, 'log_b(b^k)=k。');
    const initial = i + 2, factor = i % 3 + 2, years = i % 4 + 2, value = initial * factor ** years;
    add('exp', 'growth', i, 2, 70, `某量初始為 \\(${initial}\\)，每期變為原來的 \\(${factor}\\) 倍，經 \\(${years}\\) 期後為何？`, value,
      `指數成長：\\(${initial}\\cdot${factor}^{${years}}=${value}\\)。`, '初值乘上倍率的期數次方。');
  }

  for (let i = 0; i < 10; i++) {
    const a = [i + 1, i - 3], b = [i % 4 - 1, i % 5 + 1], dot = a[0] * b[0] + a[1] * b[1];
    add('vec', 'dot', i, 1, 55, `向量 \\(${a.join(',')}\\) 與 \\(${b.join(',')}\\) 的內積為何？`, dot,
      `內積為對應分量相乘再相加：\\(${a[0]}(${b[0]})+${a[1]}(${b[1]})=${dot}\\)。`, '內積＝x 乘 x 加 y 乘 y。');
    const p = i % 4 + 1, q = 2 * (i + 1), kk = -p * q / 2;
    add('vec', 'perpendicular', i, 2, 80, `向量 \\((k,${p})\\) 與 \\((2,${q})\\) 垂直，求 \\(k\\)。`, kk,
      `垂直表示內積為 0：\\(2k+${p}(${q})=0\\)，故 \\(k=${kk}\\)。`, '向量垂直立刻寫內積等於 0。');
  }

  for (let i = 0; i < 10; i++) {
    const a = [i + 1, i - 2, i % 4 + 1], b = [i % 3 - 1, 2, 3 - i], dot = a.reduce((s, x, j) => s + x * b[j], 0);
    add('svec', 'dot', i, 1, 65, `空間向量 \\(${a.join(',')}\\) 與 \\(${b.join(',')}\\) 的內積為何？`, dot,
      `三個對應分量相乘相加，得 \\(${dot}\\)。`, '三維內積只是比二維多一個分量。');
    const v = [i + 1, i % 5 + 2, i % 3 + 3], norm2 = v.reduce((s, x) => s + x * x, 0);
    add('svec', 'norm-square', i, 1, 60, `空間向量 \\(${v.join(',')}\\) 的長度平方為何？`, norm2,
      `長度平方為分量平方和：\\(${v.map((x) => `${x}^2`).join('+')}=${norm2}\\)。`, '問長度平方就不用開根號。');
  }

  for (let i = 0; i < 10; i++) {
    const p = [i - 2, i % 4, i + 1], d = i + 1, c = 13 * d - 3 * p[0] - 4 * p[1] - 12 * p[2];
    add('splane', 'distance', i, 2, 115, `點 \\(( ${p.join(',')})\\) 到平面 \\(3x+4y+12z${sign(c)}=0\\) 的距離為何？`, d,
      `距離 \\(=\\frac{|3x_0+4y_0+12z_0+d|}{\\sqrt{3^2+4^2+12^2}}=\\frac{${13 * d}}{13}=${d}\\)。`, '點到平面公式是點到直線公式多一個 z。');
    const lp = [i % 3, i % 4, i % 5], lv = [1, i % 2 + 1, i % 3 + 1], t = i + 1;
    const left = lp.reduce((s, x) => s + x, 0), coef = lv.reduce((s, x) => s + x, 0), rhs = left + coef * t;
    add('splane', 'line-plane', i, 2, 120, `直線 \\((x,y,z)=(${lp.join(',')})+t(${lv.join(',')})\\) 與平面 \\(x+y+z=${rhs}\\) 相交，求 \\(t\\)。`, t,
      `代入得 \\(${left}+${coef}t=${rhs}\\)，所以 \\(t=${t}\\)。`, '線面交點先把參數式整組代入平面。');
  }

  for (let i = 0; i < 10; i++) {
    const A = [i + 1, i % 4 + 1, i % 3 + 1, i + 3], det = A[0] * A[3] - A[1] * A[2];
    add('mat', 'det', i, 1, 55, `求二階行列式 \\(\\begin{vmatrix}${A[0]}&${A[1]}\\\\${A[2]}&${A[3]}\\end{vmatrix}\\) 的值。`, det,
      `\\(ad-bc=${A[0]}(${A[3]})-${A[1]}(${A[2]})=${det}\\)。`, '二階行列式交叉相乘後相減。');
    const B = [i % 5 + 1, 2, i % 4 - 1, 3], cell = A[0] * B[0] + A[1] * B[2];
    add('mat', 'product', i, 2, 85, `\\(A=\\begin{bmatrix}${A[0]}&${A[1]}\\\\${A[2]}&${A[3]}\\end{bmatrix}\\)、B=\\begin{bmatrix}${B[0]}&${B[1]}\\\\${B[2]}&${B[3]}\\end{bmatrix}\\)，求 \\(AB\\) 的第 1 列第 1 行元素。`, cell,
      `取 A 第 1 列與 B 第 1 行內積：\\(${A[0]}(${B[0]})+${A[1]}(${B[2]})=${cell}\\)。`, '只問一格就只抓對應的列與行。');
  }

  const ids = new Set(BANK.map((q) => q.id));
  for (const q of out) {
    if (ids.has(q.id)) throw new Error(`核心變式題目 id 重複：${q.id}`);
    ids.add(q.id);
    BANK.push(q);
  }
})();
