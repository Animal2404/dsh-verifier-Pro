# dsh-verifier-brain 鈥?璺嚎鍥撅紙ROADMAP锛?
## P0锛氬伐鍏峰眰 鉁咃紙宸插畬鎴愶級

- [x] Python stdio 妗ワ紙绾跨▼姹犲苟鍙?+ tracker 閿?+ 宕╂簝鑷噸鍚?+ EOF 鎺掓按锛?- [x] 鍏釜宸ュ叿锛歴elect / compare / track / progress / task_start / task_status
- [x] 鍑嵁澶嶇敤锛坄~/.dsh/.credentials.yaml` + 浠ｇ悊鍒悕鏄犲皠锛?- [x] Windows 閫傞厤锛坴env 鑷姩鎺㈡祴銆乯unction 鏋勫缓銆佹棤 POSIX 鍋囪锛?- [x] 鐪熷疄绔埌绔獙璇侊紙opencode-go 绔偣锛宒eepseek-v4-flash锛宭ogprobs 鍚庣锛夛細
  - `compare` 杩斿洖 reward
  - `progress` start鈫抲pdate(0.0鈫?.684)鈫抍lose 鍏ㄦ祦绋嬫甯?  - `select` 涓夊€欓€夐€変腑姝ｇ‘ winner锛坕ndex=0锛?  - token 璁￠噺鍙敤锛堝疄娴嬬紦瀛樺懡涓巼 65%锛?
## P1锛氫娇鐢ㄩ棴鐜紙褰撳墠闃舵锛?
- [x] system prompt 娉ㄥ叆 verifier 浣跨敤绛栫暐锛堝惈鍥㈤槦闆嗘垚鍗忚锛?- [x] 缁撴灉缂撳瓨锛堣繘绋嬪唴锛岀浉鍚岃姹備笉閲嶅璁¤垂锛?- [x] 寮傛浠诲姟 + 钀界洏鎸佷箙鍖栵紙璺ㄩ噸鍚彲鏌ワ級
- [x] 棣栬疆瀹炴垬闂淇锛?026-08-21锛夛細鍚屾/寮傛瓒呮椂棰勭畻鍒嗙锛坱askTimeoutMs 30min锛夈€?  flat scores 鏍囪锛坰ignal:"flat" + 寮哄埗 compare 澶嶆牳锛夈€佷腑鏂囪浇鑽?UTF-8 淇
  锛?X utf8 + reconfigure锛孍2E 鍥炲綊閫氳繃锛夈€乼ask_status 闀胯疆璇紙wait_seconds锛?- [x] Best-of-N 鍗囩骇涓?鍚堝苟鑰岄潪浠呰瘎姣?锛氭帓鍚?鈫?鏁村悎浠ｇ悊鍚堝苟锛堝悇鍙栨墍闀匡級鈫?  `compare(鍚堝苟鐗? 鍐犲啗)` 闂ㄧ鈥斺€斿叏閮ㄨ惤鍦?prompt 绛栫暐灞傦紝verifier 淇濇寔绾?reward 瑙掕壊
- [ ] `/bestofn` 鍛戒护锛歱roblem 鈫?骞惰 N 涓瓙浠ｇ悊 鈫?select 鈫?鍚堝苟 鈫?闂ㄧ锛屼竴閿畬鎴?- [ ] AgentTeams 娣卞害鑱斿姩锛氶槦闀垮竷缃叧閿换鍔℃椂鑷姩 fan-out 鍒板鎴愬憳骞?select
- [ ] 杩涘害浼犳劅鍣ㄨ嚜鍔ㄥ寲锛氶暱浠诲姟鍏抽敭鑺傜偣鑷姩 update锛屼綆鍒嗛槇鍊艰Е鍙戦噸娲惧缓璁?
## P2锛氬熀纭€璁炬柦鍖?
- [ ] Web UI 璁剧疆闈㈡澘锛氬悗绔?妯″瀷閫夋嫨銆佸垎鏁版洸绾匡紙SVG锛夈€佸巻鍙叉祻瑙?- [ ] `/evaluate-session`锛氭彁鍙栧綋鍓嶄細璇?assistant 姝ラ鎵归噺 track 璇勫垎瀵煎嚭
- [ ] 鍒嗘暟鍘嗗彶鏌ヨ宸ュ叿锛堣 history.jsonl锛屼緵 agent 澶嶇洏锛?- [ ] 涓?dsh-trajectory-debug 绫绘彃浠跺彔鍔犲睍绀?verifier 鍒嗘暟
- [ ] 澶氭ā鎬侀獙璇侊紙`LLM_VERIFIER_ALLOW_IMAGES=1` + Vertex/Gemini 鍚庣鐪熷疄楠岃瘉锛?
## P3锛氳妯″寲

- [ ] TS 鍘熺敓绉绘璇勪及锛堝墠鎻愶細纭鍙敤鍚庣绋冲畾杩斿洖 logprobs锛屽噺灏戣繘绋嬪紑閿€锛?- [ ] 鑷甫 benchmark 鑷锛圱erminal-Bench 杞ㄨ抗鏍蜂緥浣滀负鍙戝竷闂ㄦ锛?- [ ] RL 鏁版嵁椋炶疆锛歨istory.jsonl 浣滀负 reward 鏁版嵁闆嗗鍑猴紙JSONL 鈫?璁粌绠＄嚎锛?
## 闈炵洰鏍?/ 杈圭晫

- 涓嶆妸 DSH `ctx.llm` 褰?logprobs 鏉ユ簮锛堟帴鍙ｄ笉鏆撮湶锛夈€?- 涓嶉噸澶嶅疄鐜板畼鏂圭畻娉曪紱Python 闈繚鎸佽杽銆?- 涓嶅仛閫氱敤"瑁佸垽"浜у搧锛岃仛鐒?DSH agent 鐨勯獙璇佷笌鍙嶉鍦烘櫙銆?
## 宸茬煡闄愬埗

- 鏈満 DeepSeek 涓荤珯 key 浣欓涓嶈冻锛?02锛夛紝褰撳墠鍚庣涓?opencode-go 浠ｇ悊锛?  flash 妯″瀷鍗曟璇勪及鐨勬垚瀵?reward 鍖哄垎搴︽湁闄愶紙瀹炴祴 3 鍊欓€?select 鏇惧叏 0.5 骞冲垎鈥斺€?  鐜板凡鐢?flat 妫€娴嬫爣璁板苟寮哄埗 compare 澶嶆牳锛涜姹傛洿楂樼簿搴︽椂鎻愰珮 `n_evaluations`锛夈€?- 寮傛浠诲姟鍦ㄦˉ杩涚▼瀛樻椿鏈熷唴鏈夋晥锛涙ˉ閲嶅惎鍚庣敱 tasks.jsonl 鍏滃簳鏌ヨ锛堢粨鏋滀互钀界洏璁板綍涓哄噯锛夈€?- 澶ц浇鑽凤紙澶氬€欓€夊畬鏁翠唬鐮侊級鐨勯敠鏍囪禌璇勫垎鑰楁椂鐪熷疄瀛樺湪锛氬帇缂╄浇鑽?+ 寮傛浠诲姟 +
  `wait_seconds` 闀胯疆璇㈡槸褰撳墠鐨勬帹鑽愬Э鍔匡紙瑙?README 瀹炴垬璋冪敤绾緥锛夈€?