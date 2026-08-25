/* 私有教材只在 Supabase／本機保存；此檔僅列不含內頁內容的書目與匯入狀態。 */
'use strict';

const TEXTBOOK_LIBRARY = {
  schema: 1,
  subject: 'math-a',
  series: '114 學測課程主題練習教材',
  verifiedCount: 24,
  books: [
    { id:'matha-114-data', title:'一維二維數據分析', file:'114學測班一維二為數據分析.pdf', pages:282, kind:'chapter', topics:['data'], ingestion:'pending-qa', eligibility:'core' },
    { id:'matha-114-cubic-ineq', title:'三次函數與多項式不等式', file:'114學測班三次函數與多項式不等式.pdf', pages:198, pdfSha256:'e87ad8f0e0b0d26c5bd934770686e10a168fd326a9486e90cac72ee57419b5c1', kind:'chapter', topics:['poly'], ingestion:'ready', eligibility:'core', sourceNames:['114班·三次函數與多項式'] },
    { id:'matha-114-trig-radian', title:'三角比與弧度量', file:'114學測班三角比與弧度量.pdf', pages:206, pdfSha256:'7d59504e9a4c7dc113db72b1d5e26b5dc478f8a576714952e96f1eee9af540bf', kind:'chapter', topics:['trig1'], ingestion:'ready', eligibility:'core', sourceNames:['114班·三角比與弧度量'] },
    { id:'matha-114-trig-graph', title:'三角函數的圖形與應用', file:'114學測班三角函數的圖形與應用.pdf', pages:222, pdfSha256:'caa5665528006ccec20c2703767970ff1388750cb4c9c7a65dd909bfbdd7acf8', kind:'chapter', topics:['trig2'], ingestion:'pending-qa', eligibility:'core' },
    { id:'matha-114-matrix-equation', title:'方程式與矩陣運算', file:'114學測班方程式與矩陣運算.pdf', pages:270, kind:'chapter', topics:['mat'], ingestion:'pending-qa', eligibility:'core' },
    { id:'matha-114-classical-probability', title:'古典機率與期望值', file:'114學測班古典機率與期望值.pdf', pages:212, pdfSha256:'6554f3759d22856951c0262bf174392c1e8dcbb125c661cec5e48a9359b58211', kind:'chapter', topics:['prob'], ingestion:'ready', eligibility:'core', sourceNames:['114班·機率與期望值'] },
    { id:'matha-114-plane-vector', title:'平面向量與內積應用', file:'114學測班平面向量與內積應用.pdf', pages:314, kind:'chapter', topics:['vec'], ingestion:'pending-qa', eligibility:'core' },
    { id:'matha-114-linear-transform', title:'平面線性變換與空間概念', file:'114學測班平面線性變換與空間概念.pdf', pages:238, kind:'chapter', topics:['mat','splane'], ingestion:'pending-qa', eligibility:'core' },
    { id:'matha-114-sine-cosine-law', title:'正餘弦定理與差角公式', file:'114學測班正餘弦定理與差角公式.pdf', pages:300, pdfSha256:'63b4f28820b3af5a8132585bd51e8a796200a553237b6f4a58e370bdc3afa005', kind:'chapter', topics:['trig1','trig2'], ingestion:'ready', eligibility:'core', sourceNames:['114班·正餘弦定理與差角'] },
    { id:'matha-114-polynomial-quadratic', title:'多項式運算與一次二次函數', file:'114學測班多項式運算與一次二次函數.pdf', pages:246, pdfSha256:'afa1a19d10f5232c1453739487902c39c79d826a814c9c54bea802ab04d6bc4a', kind:'chapter', topics:['poly'], ingestion:'pending-qa', eligibility:'core' },
    { id:'matha-114-cramer-circle', title:'克拉瑪公式與圓線幾何', file:'114學測班克拉瑪公式與圓線幾何.pdf', pages:304, pdfSha256:'92acde764f180e8974f14aef8a916ecb74e904284814f4e2bd0bc74e726fea1c', kind:'chapter', topics:['line','mat'], ingestion:'ready', eligibility:'core', sourceNames:['114班·克拉瑪與圓線'] },
    { id:'matha-114-line-inequality', title:'直線與二元一次不等式', file:'114學測班直線與二元一次不等式.pdf', pages:206, pdfSha256:'b397480cc3ace0b6c062d253c331ee28dd72daba3faa62feb0c7ce50d6bc7656', kind:'chapter', topics:['line'], ingestion:'pending-qa', eligibility:'core' },
    { id:'matha-114-space-plane-line', title:'空間中的平面與直線', file:'114學測班空間中的平面與直線.pdf', pages:292, kind:'chapter', topics:['splane'], ingestion:'pending-qa', eligibility:'core' },
    { id:'matha-114-space-vector', title:'空間向量與三階行列式', file:'114學測班空間向量與三階行列式.pdf', pages:248, kind:'chapter', topics:['svec','splane'], ingestion:'pending-qa', eligibility:'core' },
    { id:'matha-114-exp-log', title:'指數函數與常用對數', file:'114學測班指數函數與常用對數.pdf', pages:262, pdfSha256:'babfcd9154b586af4f208699f72dc196dc7579b656599580e75d7c68b1b00d61', kind:'chapter', topics:['exp'], ingestion:'ready', eligibility:'core', sourceNames:['114班·指數與常用對數'] },
    { id:'matha-114-permutation', title:'排列組合與二項式定理', file:'114學測班排列組合與二項式定理.pdf', pages:298, pdfSha256:'7e682880679363a5f20d4520d81964c7d3b57ae54ef97735f4c91fd052e4da70', kind:'chapter', topics:['comb'], ingestion:'ready', eligibility:'core', sourceNames:['114班·排列組合'] },
    { id:'matha-114-conditional-probability', title:'條件機率與獨立事件', file:'114學測班條件機率與獨立事件.pdf', pages:240, kind:'chapter', topics:['prob'], ingestion:'pending-qa', eligibility:'core' },
    { id:'matha-114-real-number-line', title:'實數與數線上的幾何', file:'114學測班實數與數線上的幾何.pdf', pages:182, pdfSha256:'018659d0af52c6464863f5088c29fe8ce0638193faddd2c361a3695687bd5f7b', kind:'chapter', topics:['num'], ingestion:'ready', eligibility:'core', sourceNames:['114班·實數與數線'] },
    { id:'matha-114-log-function', title:'對數運算與對數函數', file:'114學測班對數運算與對數函數.pdf', pages:270, pdfSha256:'0efa325621fb36fa4f1e5109083853790fc284457b458e363d874772a71fd95b', kind:'chapter', topics:['exp'], ingestion:'ready', eligibility:'core', sourceNames:['114班·對數運算與函數'] },
    { id:'matha-114-sequence', title:'數列遞迴與級數求和', file:'114學測班數列遞迴與級數求和.pdf', pages:262, pdfSha256:'12c52c89d4ea465aaae58eaefc08bb8744044d9ee9dde4de6f0b5a746da723d9', kind:'chapter', topics:['seq'], ingestion:'pending-qa', eligibility:'core' },
    { id:'mathb-114-read-write', title:'數 B 滿分讀寫教材', file:'114學測班數B滿分讀寫教材.pdf', pages:160, kind:'read-write', topics:[], ingestion:'pending-qa', eligibility:'supplement' },
    { id:'matha-114-logic-set', title:'邏輯集合與計數原理', file:'114學測班邏輯集合與計數原理.pdf', pages:192, pdfSha256:'deb5333322574126912c690271937a5c8b55e62172e803197a87ee263bc8ab3e', kind:'chapter', topics:['num','comb'], ingestion:'ready', eligibility:'core', sourceNames:['114班·邏輯集合與計數'] },
    { id:'matha-114-review-upper', title:'數學 A 滿級分寶典（上）', file:'114學測數學A滿級分寶典(上).pdf', pages:414, kind:'comprehensive-review', topics:[], ingestion:'pending-qa', eligibility:'core' },
    { id:'matha-114-review-lower', title:'數學 A 滿級分寶典（下）', file:'114學測數學A滿級分寶典(下).pdf', pages:392, kind:'comprehensive-review', topics:[], ingestion:'pending-qa', eligibility:'core' },
  ],
  supplemental: [
    { id:'matha-weekly-review', title:'週攻略數學 A', file:'週攻略數學A.pdf', pages:510, kind:'supplemental-review', ingestion:'not-planned' },
  ],
};

if (typeof module !== 'undefined' && module.exports) module.exports = TEXTBOOK_LIBRARY;
