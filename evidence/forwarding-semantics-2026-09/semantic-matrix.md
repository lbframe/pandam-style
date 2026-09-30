# Independent forwarding semantic matrix

Tested commit: `1719a0494f3f593cfa052493ef7a28be4c9d448e`; tree: `024073d3190df441c0ee582dfd17f91ea34a2875`.

Each expectation is handwritten in the oracle. Fresh and incremental actuals are independently observed. All three semantic comparisons and the view audit pass in all 47 rows.

| fixture | fresh expected | fresh actual | incremental actual | verdict |
| --- | --- | --- | --- | --- |
| direct import | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| named source re-export | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| removed export | create→create; rejected [PMS_FORBIDDEN_IMPORT] | create→create; rejected [PMS_FORBIDDEN_IMPORT] | create→create; rejected [PMS_FORBIDDEN_IMPORT] | pass |
| restored export | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| renamed source re-export | css→create, t→token; style | css→create, t→token; style | css→create, t→token; style | pass |
| local import + re-export | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| local import + renamed re-export | css→create, token→token; style | css→create, token→token; style | css→create, token→token; style | pass |
| export star | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| namespace source re-export | pms.create→create, pms.token→token; style | pms.create→create, pms.token→token; style | pms.create→create, pms.token→token; style | pass |
| namespace import + export | pms.create→create, pms.token→token; style | pms.create→create, pms.token→token; style | pms.create→create, pms.token→token; style | pass |
| multi-hop named forwarding | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| multi-hop renamed forwarding | css→create, token→token; style | css→create, token→token; style | css→create, token→token; style | pass |
| multi-hop star forwarding | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| partial forwarding | create→create; rejected [PMS_FORBIDDEN_IMPORT] | create→create; rejected [PMS_FORBIDDEN_IMPORT] | create→create; rejected [PMS_FORBIDDEN_IMPORT] | pass |
| same exported spelling before remap | css→create; style | css→create; style | css→create; style | pass |
| same exported spelling remapped | css→token; rejected [PMS_NON_STATIC_VALUE] | css→token; rejected [PMS_NON_STATIC_VALUE] | css→token; rejected [PMS_NON_STATIC_VALUE] | pass |
| same exported spelling restored | css→create; style | css→create; style | css→create; style | pass |
| mixed source barrel | create→create; rejected [PMS_NON_STATIC_VALUE] | create→create; rejected [PMS_NON_STATIC_VALUE] | create→create; rejected [PMS_NON_STATIC_VALUE] | pass |
| non-PandamStyle same-name export | ; ordinary | ; ordinary | ; ordinary | pass |
| relay before break | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| relay break | ; ordinary | ; ordinary | ; ordinary | pass |
| relay restore | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| relay file removal | ; rejected [PMS_COVERAGE_GAP] | ; rejected [PMS_COVERAGE_GAP] | ; rejected [PMS_COVERAGE_GAP] | pass |
| relay file restoration | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| deep negative answer | ; ordinary | ; ordinary | ; ordinary | pass |
| deep negative repair | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| star collision | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | pass |
| star explicit override | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| star same-origin diamond | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| star after renamed forwarding | css→create, t→token; style | css→create, t→token; style | css→create, t→token; style | pass |
| namespace of partial renamed barrel | pms.css→create, pms.t→token; style | pms.css→create, pms.t→token; style | pms.css→create, pms.t→token; style | pass |
| direct namespace import | pms.create→create, pms.token→token; style | pms.create→create, pms.token→token; style | pms.create→create, pms.token→token; style | pass |
| default as foo is absent | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | pass |
| default forwarding is absent | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | pass |
| metadata alias has no helper authority | ; ordinary | ; ordinary | ; ordinary | pass |
| namespace partial forwarding rejects missing token | pms.create→create; rejected [PMS_NON_STATIC_VALUE] | pms.create→create; rejected [PMS_NON_STATIC_VALUE] | pms.create→create; rejected [PMS_NON_STATIC_VALUE] | pass |
| direct token alias lowers | t→token; token | t→token; token | t→token; token | pass |
| transitive star collision stays ambiguous | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | pass |
| ordinary destructured exports collide | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | pass |
| unknown external star fails closed | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | pass |
| star cycle fails closed | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | ; rejected [PMS_FORBIDDEN_IMPORT] | pass |
| resolution candidate appears | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| earlier resolution candidate replaces origin | ; ordinary | ; ordinary | ; ordinary | pass |
| earlier candidate removed restores origin | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| first-hop candidate before replacement | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
| first-hop earlier candidate replaces origin | ; ordinary | ; ordinary | ; ordinary | pass |
| first-hop earlier candidate removal restores origin | create→create, token→token; style | create→create, token→token; style | create→create, token→token; style | pass |
