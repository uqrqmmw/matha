/**
 * Immutable source-image catalog for authoritative paper grading.
 *
 * Every object was read back from the private matha-papers bucket and hashed
 * before this catalog was committed.  Storage provenance alone is never
 * trusted: Edge must verify the exact bytes against these SHA-256 values.
 * Replacing a scan requires a reviewed catalog/code deployment.
 */
export type PaperGradeAssetSide = "left" | "right" | "full";

export type PaperGradeSourceAsset = {
  path: string;
  sha256: string;
  width: number;
  height: number;
  side: PaperGradeAssetSide;
};

export const PAPER_GRADE_SOURCE_ASSETS: Readonly<
  Record<string, readonly PaperGradeSourceAsset[]>
> = {
  "paper-mock-1": [
    {
      "path": "mock-1-page-1-2.png",
      "sha256":
        "74f102de69159d05a535b1964da9225d3f752fc1e93b71229bf3e4cae8e26316",
      "width": 2105,
      "height": 1488,
      "side": "left",
    },
    {
      "path": "mock-1-page-1-2.png",
      "sha256":
        "74f102de69159d05a535b1964da9225d3f752fc1e93b71229bf3e4cae8e26316",
      "width": 2105,
      "height": 1488,
      "side": "right",
    },
    {
      "path": "mock-1-page-3-4.png",
      "sha256":
        "79a9c134a6d0940695b5954a822c5456d01c7f99b2978b4245725d1e84ded716",
      "width": 2105,
      "height": 1488,
      "side": "left",
    },
    {
      "path": "mock-1-page-3-4.png",
      "sha256":
        "79a9c134a6d0940695b5954a822c5456d01c7f99b2978b4245725d1e84ded716",
      "width": 2105,
      "height": 1488,
      "side": "right",
    },
    {
      "path": "mock-1-page-5-6.png",
      "sha256":
        "0cabf21c579422624511e8b7446874a8097cf19b7b3f2cd1fb1f87c2f841028c",
      "width": 2105,
      "height": 1488,
      "side": "left",
    },
    {
      "path": "mock-1-page-5-6.png",
      "sha256":
        "0cabf21c579422624511e8b7446874a8097cf19b7b3f2cd1fb1f87c2f841028c",
      "width": 2105,
      "height": 1488,
      "side": "right",
    },
  ],
  "paper-mock-3": [
    {
      "path": "mock-3-page-1-2.png",
      "sha256":
        "b56ed83d321751cae38eaea7766af48aa83b7b9c2e58000606a582c0b402cce6",
      "width": 2105,
      "height": 1488,
      "side": "left",
    },
    {
      "path": "mock-3-page-1-2.png",
      "sha256":
        "b56ed83d321751cae38eaea7766af48aa83b7b9c2e58000606a582c0b402cce6",
      "width": 2105,
      "height": 1488,
      "side": "right",
    },
    {
      "path": "mock-3-page-3-4.png",
      "sha256":
        "b79b6222a01a2e0c1b93971b5e9fc0a4bb5909eaec82ac3f018b03bc07d5cbe5",
      "width": 2105,
      "height": 1488,
      "side": "left",
    },
    {
      "path": "mock-3-page-3-4.png",
      "sha256":
        "b79b6222a01a2e0c1b93971b5e9fc0a4bb5909eaec82ac3f018b03bc07d5cbe5",
      "width": 2105,
      "height": 1488,
      "side": "right",
    },
  ],
  "paper-official-110-trial": [
    {
      "path": "official-110-trial-matha/page-01-50c82613a928.png",
      "sha256":
        "50c82613a928a9cd09f4e11d0455e66c20ba3cc652957c3e960757661bbccd37",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-110-trial-matha/page-02-a1ddced5d91f.png",
      "sha256":
        "a1ddced5d91f444e5b750bcdbe388fd561441c001561cf0b6bb089482da2f9b5",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-110-trial-matha/page-03-fc57a54ad69c.png",
      "sha256":
        "fc57a54ad69c3b4774df32fd5feafaab8f18fc9fd6bd2b29d42335afe9a926f6",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-110-trial-matha/page-04-2d6f39c2cc79.png",
      "sha256":
        "2d6f39c2cc79d0d8a209ec2a5320eb4011fc45594d5a555bc34d4f2d4407f874",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-110-trial-matha/page-05-23bbc9f91fbd.png",
      "sha256":
        "23bbc9f91fbd7a728325dd7999de0bfa3ad718b765f796b3f0ffc5a51980cada",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-110-trial-matha/page-06-401927da4a18.png",
      "sha256":
        "401927da4a18dc82500715e6266c6579acf25b46b00a35470d14ddac300a2622",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-110-trial-matha/page-07-1944757fb86e.png",
      "sha256":
        "1944757fb86e0ec6678db57564e8c296e246ac6e30ab86e1fe41a4cc0eeb8285",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-110-trial-matha/page-08-d01cc52d121b.png",
      "sha256":
        "d01cc52d121b69a9eb0953af6f3c8829bef0f1686acc9a5f2bded55011264142",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
  "paper-official-111": [
    {
      "path": "official-111-matha/page-01-6d2ee0d8e5a2.png",
      "sha256":
        "6d2ee0d8e5a294841cb7406d4bdca08e73a9b3d4ab0379e3f56b3b523b8350ba",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-111-matha/page-02-ba7270acbf4c.png",
      "sha256":
        "ba7270acbf4cef90f924fb3cd26d1bc4e6f833866af75a67ce539402d64d0d11",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-111-matha/page-03-a12b580d5897.png",
      "sha256":
        "a12b580d58974cacc734c870d98fa30b047956413bbf3ad57552a6d3e6c4a805",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-111-matha/page-04-29887ee5a84a.png",
      "sha256":
        "29887ee5a84a2297629ca203e15b186ebee1c0f403fc11c57d1ce5f9e576a8fa",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-111-matha/page-05-419cd72d868e.png",
      "sha256":
        "419cd72d868eaac3e3f28d7e28374c4199fe77709ed2ea762293ba94ad6dfab8",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-111-matha/page-06-cefd639d8791.png",
      "sha256":
        "cefd639d87915ede0b6d9d3c73bbda2968d16fe39b73c1b00e54db7b22a53771",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-111-matha/page-07-3f9ada1b9958.png",
      "sha256":
        "3f9ada1b9958cb615e05cb8871b2f5a163312266c121abf4857cc715109d0a88",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-111-matha/page-08-1a792ad8df0a.png",
      "sha256":
        "1a792ad8df0ad913286ad6d0fe3281fef9ae8263e4eaa9923551cfda9f22421d",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
  "paper-official-112": [
    {
      "path": "official-112-matha/page-01-b7f00868bad7.png",
      "sha256":
        "b7f00868bad7c3be681076a31977f283083a822c3387aa25690de16a56b44773",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-112-matha/page-02-73fc0b04c51b.png",
      "sha256":
        "73fc0b04c51b4cda307bf9f55c9e362d5bbd57e2a04fd8fb4f52c1866caa4650",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-112-matha/page-03-cd8ea07294ef.png",
      "sha256":
        "cd8ea07294eff2d7c147be03835635cf483feee2ee21d477eb2e35d0e5305498",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-112-matha/page-04-6ffec5c90c8c.png",
      "sha256":
        "6ffec5c90c8ca50d63bc193931c7f8d4fef408f07c58cb33bb285d989ea71ecc",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-112-matha/page-05-d03af7835612.png",
      "sha256":
        "d03af783561200264cc9fbbfaf644f38a721488fe594b2aeb7470d030ca24092",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-112-matha/page-06-e497baa85bbe.png",
      "sha256":
        "e497baa85bbe25e377a282bc3da357b92acf7a8eb7190ceff92a64a9ad1da3f0",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-112-matha/page-07-e7000f0b5dba.png",
      "sha256":
        "e7000f0b5dba7d2549b3683d29f5b18fa782ca90e2bfa5e22566e83525b0ca2d",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-112-matha/page-08-6202650ec424.png",
      "sha256":
        "6202650ec42451a726602dbd973525d67b4b7c5029d39cb39d4ef609689f87c0",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
  "paper-official-113": [
    {
      "path": "official-113-matha/page-01-eee9343ec22a.png",
      "sha256":
        "eee9343ec22a96f37185efa93dfa71ec7d1e1cd0d4c5fc26d64d01d54cf1a194",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-113-matha/page-02-23fb165daf4e.png",
      "sha256":
        "23fb165daf4eb33d82957bebef74edd5c2c0769bf9e611687415f79adc2bc48e",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-113-matha/page-03-2d9710d3f56c.png",
      "sha256":
        "2d9710d3f56c00a8b34d04e98868ad2ae1222c5d6f5d722d48480311cf415aea",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-113-matha/page-04-fbf39e6bbb8e.png",
      "sha256":
        "fbf39e6bbb8e6a9f1061d4517acee1cffa838a864a6e445b6fd83648b2b0e5a7",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-113-matha/page-05-48486f917f42.png",
      "sha256":
        "48486f917f424a7e7bf30eb5d79a7f2137df4d9b9cc2c917f11655dcf4ed701d",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-113-matha/page-06-3058d5040f01.png",
      "sha256":
        "3058d5040f01076a4ecf254d4715dc82275b7aadc0c3626677081cdea6ea5ba4",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-113-matha/page-07-c3883a3588a6.png",
      "sha256":
        "c3883a3588a601cc9df4dabf2ee09f26ae9f0bdcf2a49c16e9fde8249dc3bc85",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-113-matha/page-08-086ada14d28c.png",
      "sha256":
        "086ada14d28c542b52caaca828a7e17c958ab7c3d54f5b18ed5f3285199c9801",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
  "paper-official-114": [
    {
      "path": "official-114-matha/page-01-b96d45addc85.png",
      "sha256":
        "b96d45addc8519c382295496fe990997dda55ae1090808714d577192ff957273",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-114-matha/page-02-dd63403e321a.png",
      "sha256":
        "dd63403e321ab6f2d8f9f894a5618f69c554e771d4db13230e5301e1ac39691a",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-114-matha/page-03-a7228cc1ef21.png",
      "sha256":
        "a7228cc1ef21cccc5c960788e5212c82a02fa5c49ad75ed1d3f62e72b1b1689b",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-114-matha/page-04-f7bafb6e70d2.png",
      "sha256":
        "f7bafb6e70d24a336e736076a1bf34f57aaf670d0e4b864b4d6aa47cffecc50c",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-114-matha/page-05-073a3497ec53.png",
      "sha256":
        "073a3497ec53da7cc71bc7305a6dcdadf76340ec35f77c6a6984f634038a0999",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-114-matha/page-06-4758f91b0619.png",
      "sha256":
        "4758f91b0619d6690ddafa8c164659309fdf54893ef7fb4316ea185bd4adbfc3",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-114-matha/page-07-13bbd74bfd56.png",
      "sha256":
        "13bbd74bfd5602962ba8723598ffdb9bfe07907afa687e4b61984db3e63003a6",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-114-matha/page-08-4d5b2a7f319b.png",
      "sha256":
        "4d5b2a7f319bd56ade611b41c5e9c41591baf80d23e84c27f9279415040084a2",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
  "paper-official-115": [
    {
      "path": "official-115-matha/page-01-f9b57a554e7b.png",
      "sha256":
        "f9b57a554e7b15393e623bf793a1014a196020bc620e0912ef034f9d9051d4a2",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-115-matha/page-02-a3ba31680f05.png",
      "sha256":
        "a3ba31680f057071e030874db4ef59a679d02e5e845a0d7b0f70993fc81de2a7",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-115-matha/page-03-a78109d8868b.png",
      "sha256":
        "a78109d8868b808262bb8fe6c3509d2959464c9cf314197e321664ebf96307d0",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-115-matha/page-04-127ecb9f9422.png",
      "sha256":
        "127ecb9f94223ede09ae774d538175203dcbf18d5fa16f67ed91f1ddad7b5d7a",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-115-matha/page-05-fab9f239ae96.png",
      "sha256":
        "fab9f239ae9625302e58abc807c9c21d3f94e814abd9fec77cf1f19829b9778e",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-115-matha/page-06-2548f9513d06.png",
      "sha256":
        "2548f9513d06905be6e555dc40aafa894f98e9c77bb7258afd87f38578456835",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-115-matha/page-07-7e52429b12a2.png",
      "sha256":
        "7e52429b12a218a0b66da28adbc60530fe425fbc338da5bb763b17824efa3156",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "official-115-matha/page-08-b1e8c6f15575.png",
      "sha256":
        "b1e8c6f15575fc870f47402473239a81b23f0c16ff2630ba560ea0a5273e3c83",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
  "paper-regional-ra1103": [
    {
      "path": "regional-ra1103-matha/page-01-25a9a2eacfc3.png",
      "sha256":
        "25a9a2eacfc35475fdca5f149bf6b9375c594d52e9cef10beecf1cc296268b18",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra1103-matha/page-02-a56cc0f1bc31.png",
      "sha256":
        "a56cc0f1bc311061297586d2de7e82fc9f6aa93ed5ca54fe0e4eb37e7845685a",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra1103-matha/page-03-1cf348e25c48.png",
      "sha256":
        "1cf348e25c4810f386d4591f532f827af8aa735f911e4f3a6245f3975dd9ef44",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
  "paper-regional-ra1104": [
    {
      "path": "regional-ra1104-matha/page-01-05e392240419.png",
      "sha256":
        "05e392240419c1bd026edd622a4d83002f682a720249b8fedc359982da976d6b",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra1104-matha/page-02-96d03285580f.png",
      "sha256":
        "96d03285580f17800b6d705cae08bb1cdce4a435134c3c793e38eca1cb885e8e",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra1104-matha/page-03-3d9dcd615a1f.png",
      "sha256":
        "3d9dcd615a1fe775fe8b4e2dacc22e311919e6f49739accfd845a9746c4d357b",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
  "paper-regional-ra2100": [
    {
      "path": "regional-ra2100-matha/page-01-816f96b3511b.png",
      "sha256":
        "816f96b3511b608c202c538bcdd511a963cf7dfb74819045472b6bb0198862c7",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra2100-matha/page-02-e5b641b60c81.png",
      "sha256":
        "e5b641b60c81aa65b6637d73e07bf4f027a7416e8185380027affe7d84cbd9b8",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra2100-matha/page-03-b8146866990a.png",
      "sha256":
        "b8146866990a01f4d50b2682508f83952c857ccc351fb24b01b533bbb7ca8f0a",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
  "paper-regional-ra2101": [
    {
      "path": "regional-ra2101-matha/page-01-7e70b18ba686.png",
      "sha256":
        "7e70b18ba68621d1502d5b4bca77064a1467febe2b418ceddfbffb9bd015a376",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra2101-matha/page-02-f69375c2c7c5.png",
      "sha256":
        "f69375c2c7c5cb50d7cf388212a5cac759c6cc116c24df3fd4675e058c16438b",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra2101-matha/page-03-c1284db2a869.png",
      "sha256":
        "c1284db2a86942ea315ccaefa56e46335e5c46921c405bfdb6ec03875e885b38",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
  "paper-regional-ra3101": [
    {
      "path": "regional-ra3101-matha/page-01-a33a78c5f682.png",
      "sha256":
        "a33a78c5f6823b612768735217bf8987b0a8beceef74d2a7e42a7c8c6cf24afb",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra3101-matha/page-02-e8caa0fafb20.png",
      "sha256":
        "e8caa0fafb20e3ba745e3f4802e7dad233ab1510373c4a35b1642309b0c582e0",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra3101-matha/page-03-67ea52f8d5e5.png",
      "sha256":
        "67ea52f8d5e5a7e752c75547e0830a828c2d8143428133461ba7a94120ab811f",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
  "paper-regional-ra3102": [
    {
      "path": "regional-ra3102-matha/page-01-ec4df124467b.png",
      "sha256":
        "ec4df124467bd3c7595d055e902a699fde01eaed42edad6351af45d28df331e2",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra3102-matha/page-02-0aeb00e0f9c0.png",
      "sha256":
        "0aeb00e0f9c0a7b3d64299cff83bd8f6f178889a623642956611bf1bab1cab03",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra3102-matha/page-03-726eadb32593.png",
      "sha256":
        "726eadb32593f9e1719a3201f672612663a53b5f2f8564050eae1ee5b0843de0",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
  "paper-regional-ra4109": [
    {
      "path": "regional-ra4109-matha/page-01-acc4f03027b1.png",
      "sha256":
        "acc4f03027b1bf8b89f37a48810b387af86adf79b73581d8167c69954c241730",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra4109-matha/page-02-768a55527abd.png",
      "sha256":
        "768a55527abdadb15e10f9be05c109da435ee1b88b6b1e6f35338078c8a1b420",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra4109-matha/page-03-cbb0d11270a2.png",
      "sha256":
        "cbb0d11270a211acacf63b6abe616826080df0af7eb506adee4957cc78647a26",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra4109-matha/page-04-bddf8a4baec0.png",
      "sha256":
        "bddf8a4baec0d546107671e2c973d8c6d6eb6c56f301e18ec0303cc43b357763",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
  "paper-regional-ra4110": [
    {
      "path": "regional-ra4110-matha/page-01-cc46e5c3baeb.png",
      "sha256":
        "cc46e5c3baeb0bac07cab7327d5fa6ca78c29c37b59f23eddefd45ad023a8556",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra4110-matha/page-02-34c373d48efa.png",
      "sha256":
        "34c373d48efa0990d83e75ef8c49e147108361d5fb17b1a0e4a8776b3ce41096",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
    {
      "path": "regional-ra4110-matha/page-03-710b2938f5cb.png",
      "sha256":
        "710b2938f5cba4b1d7c99424ef7268338c1beb103e3e4625cd66d31f4c74a831",
      "width": 1489,
      "height": 2105,
      "side": "full",
    },
  ],
} as const;

export const PAPER_GRADE_SOURCE_BUCKET = "matha-papers";
export const PAPER_GRADE_ASSET_CATALOG_VERSION =
  "paper-grade-source-catalog-v1-20260830";

export function paperGradeSourceAssets(sourceId: string) {
  return PAPER_GRADE_SOURCE_ASSETS[sourceId] || null;
}
