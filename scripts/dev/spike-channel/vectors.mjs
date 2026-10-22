// THROWAWAY SPIKE (#219). Published test vectors, copied verbatim from
// draft-irtf-cfrg-cpace-21 (https://www.ietf.org/archive/id/draft-irtf-cfrg-cpace-21.txt):
//   A.1.2 prepend_len, A.1.4 lv_cat, A.3.5 transcript_ir, B.5 CPace P-256/SHA-256, B.5.10-B.5.11.
// If the draft is revised, re-copy these from the new revision and re-run; do not edit by hand.

const h = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

export const stringVectors = {
  prependLen: [
    { in: Buffer.alloc(0), out: h('00') },
    { in: Buffer.from('1234'), out: h('0431323334') },
    { in: Buffer.from(Array.from({ length: 127 }, (_, i) => i)), outPrefix: h('7f00'), outLen: 128 },
    { in: Buffer.from(Array.from({ length: 128 }, (_, i) => i)), outPrefix: h('800100'), outLen: 130 },
  ],
  lvCat: { in: ['1234', '5', '', '678'].map((s) => Buffer.from(s)), out: h('043132333401350003363738') },
  transcriptIr: [
    { in: ['123', 'PartyA', '234', 'PartyB'], out: h('03313233065061727479410332333406506172747942') },
    { in: ['3456', 'PartyA', '2345', 'PartyB'], out: h('043334353606506172747941043233343506506172747942') },
  ],
};

export const b5 = {
  PRS: Buffer.from('Password'),
  CI: h('0b415f696e69746961746f720b425f726573706f6e646572'),
  sid: h('34b36454cab2e7842c389f7d88ecb7df'),
  genStr: h(`1e4350616365503235365f584d443a5348412d3235365f535357555f
             4e555f0850617373776f726417000000000000000000000000000000
             0000000000000000180b415f696e69746961746f720b425f72657370
             6f6e6465721034b36454cab2e7842c389f7d88ecb7df`),
  g: h(`0439bff2b051701594d3e9c7e93be9213af15db42214dfc4f7ee929a
        6697f774d7ba5fb289b982399e4acd281a988bf058ea7ff6d7ff34fd
        b72157bb464ff4af87`),
  ADa: Buffer.from('ADa'),
  ya: h('37574cfbf1b95ff6a8e2d7be462d4d01e6dde2618f34f4de9df869b24f532c5d'),
  Ya: h(`04cf55f0a53a1b4c43002e1be8171f42737cf20b7cd6177b901ef962
         c2e2d486b2f738263c6da5aa902fe185ae2cda587df8d27a16fc19c3
         2a7b31aab097919736`),
  ADb: Buffer.from('ADb'),
  yb: h('e5672fc9eb4e721f41d80181ec4c9fd9886668acc48024d33c82bb102aecba52'),
  Yb: h(`046f538f9b8eb4e628bcace0fbba7d36fea44e98334d233c22101a2f
         28eb3afc1a61b2bd14c0f11b222b5ea34df7756d104e2b5da09c9e8f
         fa330c150f47e84cef`),
  K: h('9dd152b687ded1e071cc0625bd1ffff4c4ccd7d77cb4987c7d1e4ecb3a0db812'),
  ISK_IR: h('d67704f1c69b85736f273e73198a79fe5e4f60cb405e32f708e0aff5fdb5f9db'),
  // B.5.10 / B.5.11
  s: h('f012501c091ff9b99a123fffe571d8bc01e8077ee581362e1bd213990835643b'),
  X: h(`0424648eb986c2be0af636455cef0550671d6bcd8aa26e0d72ffa1b1
        fd12ba4e0f78da2b6d2184f31af39e566aef127014b6936c9a37346d
        10a4ab2514faef5831`),
  sX: h(`04f5a191f078c87c36633b78c701751159d56c59f3fe9105b5720673
         470f303ab925b6a7fd1cdd8f649a21cf36b68d9e9c4a11919a951892
         519786104b27033757`),
  sXvfy: h('f5a191f078c87c36633b78c701751159d56c59f3fe9105b5720673470f303ab9'),
  Y_i1: h(`0424648eb986c2be0af636455cef0550671d6bcd8aa26e0d72ffa1b1
           fd12ba4e0f78da2b6d2184f31af39e566aef127014b6936c9a37346d
           10a4ab2514faef5857`),
  Y_i2: h('00'),
};
