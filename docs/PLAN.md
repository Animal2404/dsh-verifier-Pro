# dsh-verifier-brain 鈥?LLM-as-a-Verifier 鎻掍欢鏂规锛圥LAN锛?
> 澶ц剳锛歀LM-as-a-Verifier锛堢粏绮掑害楠岃瘉锛壜?韬共锛歞sh-agent-teams锛堝鏅鸿兘浣撳崗浣滐級

## 鐩爣

鎶婂畼鏂?[llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) 妗嗘灦鐨勭粏绮掑害鍙嶉鑳藉姏
锛坙ogprob 鏈熸湜 reward锛岃€岄潪鏅€?LLM-as-a-Judge 鐨勫崟鐐规墦鍒嗭級浠?DSH 鎻掍欢褰㈠紡娉ㄥ叆锛?骞惰瀹冩垚涓?agent 鍥㈤槦鐨?*鍐呯疆璇勫鍣ㄥ畼**锛?
1. **娴嬭瘯鏃舵墿灞曪紙Best-of-N锛?*锛氬涓垚鍛樺苟琛屼骇鍑烘柟妗堬紝`verifier select` 鐢?PPT 閿︽爣璧涢€変紭銆?2. **杩涘害璺熻釜**锛歚verifier progress` 瀹炴椂璇勪及姣忎竴姝ョ鎴愬姛澶氳繎锛屾寔缁綆鍒嗚Е鍙戠瓥鐣ヨ皟鏁淬€?3. **璐ㄩ噺闂ㄧ**锛歳eviewer 鎴愬憳鐢?`verifier compare/track` 璇勫浜や粯鐗╋紝閫氳繃鎵嶉噰绾炽€?4. **濂栧姳淇″彿**锛氬垎鏁板巻鍙叉寔涔呭寲瀵煎嚭锛圝SONL锛夛紝鍙綔涓?RL / 鏁版嵁绛涢€夌殑 reward 鏉ユ簮銆?
## 鎶€鏈矾绾?
**Python stdio 妗?+ 瀹樻柟 llm-verifier 鍖?*锛堜笌 lanbaolu/dsh-llm-verifier 鍚岃矾绾匡紝鐙珛閲嶅啓锛夛細

```
DSH Agent
  鈫?verifier select / compare / track / progress / task_start / task_status
DSH Host 鎻掍欢锛圢ode/TS, lib/锛?  鈫?JSON Lines over stdin/stdout锛堟寜 id 鍏宠仈锛屾敮鎸佷贡搴忚繑鍥烇級
Python 妗ワ紙bridge/verifier_brain_bridge.py锛岀嚎绋嬫睜骞跺彂锛?  鈫?llm-verifier锛堝畼鏂?PyPI 鍖?0.2.0锛?  鈫?logprobs 鍚庣锛圤penAI 鍏煎 / DeepSeek / Vertex / Gemini锛?```

涓轰粈涔堝繀椤昏蛋鐙珛妗ワ細缁嗙矑搴?reward 闇€瑕佽鍙?score token 鐨勫畬鏁?logprob 鍒嗗竷锛?DSH 鐨?`ctx.llm` 娴佸紡鎺ュ彛涓嶆毚闇?logprobs锛屾璺笉閫氾紙闈炵洰鏍囷紝瑙佷笅锛夈€?
## 鐩稿 lanbaolu 鍙傝€冨疄鐜扮殑涓夐」澧炲己

| 鐭澘锛堝弬鑰冨疄鐜帮級 | 鏈」鐩?|
|---|---|
| 寮傛浠诲姟/鍒嗘暟鍘嗗彶绾唴瀛樻€侊紝閲嶅惎鍗充涪 | `~/.dsh/verifier-brain/{history,tasks}.jsonl` 钀界洏锛屼换鍔＄姸鎬侀噸鍚悗鍙煡 |
| 妗ュ崟杩涚▼涓茶澶勭悊 stdin锛屽紓姝ヤ换鍔℃帓闃熷彔鍔犺€楁椂 | 妗ュ唴 `ThreadPoolExecutor`锛堥粯璁?4 worker锛夛紝tracker 鍔犻攣淇濇姢锛涘疄娴嬩贡搴忓搷搴?|
| 浠?macOS 楠岃瘉锛寁env 璺緞纭紪鐮?| Windows 涓€绛夊叕姘戯細鑷姩鎺㈡祴 `.venv/Scripts/python.exe`锛屾棤 POSIX 鍋囪 |

鍙︿慨锛氭ˉ杩涚▼宕╂簝鍚庝笅涓€娆¤姹傝嚜鍔ㄩ噸鍚紙鍙傝€冨疄鐜版寕鎺夊嵆姘镐箙澶辨晥锛夛紱stdin EOF 鏃?鎺掓按绾跨▼姹狅紙閬垮厤 in-flight 璇勫垎琚?interpreter shutdown 鏉€鎺夛級銆?
## 棣栬疆鐪熷疄浣跨敤鐨勯棶棰樹慨澶嶏紙2026-08-21锛岃 dsh-verifier-brain-issues.md锛?
| 瀹炴垬闂 | 淇 |
|---|---|
| 鍚屾/寮傛 select 閮芥挒 300s 妗ヨ秴鏃?| 瓒呮椂棰勭畻鍒嗙锛歚bridgeTimeoutMs`锛?00s锛夊彧绠″悓姝ュ伐鍏凤紱寮傛浠诲姟璧?`taskTimeoutMs`锛堥粯璁?30min锛?|
| `select` 鍏?0.5 骞冲垎琚綋浣滄湁鏁堟帓鍚?| flat 妫€娴嬶細鍏ㄧ瓑鍒嗘暟鏃惰繑鍥?`signal:"flat"` + 璀﹀憡锛屾彁绀哄繀椤?pairwise compare 澶嶆牳 |
| 涓枃杞借嵎 UTF-8 lone surrogate 宕╂簝 | spawn 鍔?`-X utf8` + 妗ュ唴 `sys.stdin/stdout.reconfigure(encoding="utf-8")`锛涗腑鏂囪浇鑽?E2E 鍥炲綊閫氳繃 |
| 寮傛浠诲姟鍙兘鐩茶疆璇?| `verifier task_status` 鏀寔 `wait_seconds` 闀胯疆璇紙cap 300s锛夛紝瀹屾垚鍗宠繑鍥?|

## 璁捐绔嬪満锛氬悎骞讹紝鑰屼笉鍙槸璇勬瘮

涓嶅悓浠ｇ悊鐨勫€欓€夊悇鏈夋墍闀匡紝"閫夊嚭鍐犲啗"鍙敤浜嗕竴鍗婄殑 Best-of-N銆傜瓥鐣ュ眰瀹氫箟涓夋闂幆锛?**鎺掑悕**锛坰elect/compare锛夆啋 **鍚堝苟**锛堝叏閮ㄥ€欓€?鍒嗘暟浜ょ粰鏁村悎浠ｇ悊鈥斺€旂嫭绔嬫垚鍛樻垨闃熼暱
鍙﹀紑涓€杞€斺€旂患鍚堝悇鍙栨墍闀跨殑鐗堟湰锛夆啋 **闂ㄧ**锛坄compare(鍚堝苟鐗? 鍐犲啗)`锛屼笉浣庝簬鍐犲啗鎵嶉噰绾筹級銆?
verifier 淇濇寔绾?reward 鍑芥暟瑙掕壊锛氫笉鎵撴枃瀛楄瘎璁恒€佷笉鍐欏悎骞剁銆傛暣鍚堟槸浠ｇ悊鐨勬椿锛?鎻掍欢鍙彁渚涘垎鏁颁笌闂ㄧ鈥斺€旇繖鏉¤竟鐣屽埢鎰忓垝娓咃紝闃叉杩囧害宸ョ▼鍖栵紙涓嶅姞 critique 妗ユ柟娉曘€?涓嶅姞鍚堝苟缂栨帓宸ュ叿锛屽叏閮ㄨ惤鍦?prompt 绛栫暐灞傦級銆?
## 宸ュ叿濂戠害

鍗曚竴 `verifier` 宸ュ叿锛坄action` 鍙傛暟鍖哄垎锛屽懡鍚嶇煭銆佺洰褰曠渷 prefill锛夛細

| action | 瀹樻柟鑳藉姏 | 杩斿洖 | 蹇呭～鍙傛暟 |
|---|---|---|---|
| `select` | select + PPT 閿︽爣璧?| `index` / `ranking` / `scores`锛坒lat 鏃堕檮 `signal:"flat"`锛?| `problem` `candidates` `criteria` |
| `compare` | compare锛堟垚瀵圭粏绮掑害 reward锛?| `reward_a` / `reward_b` | `problem` `candidate_a` `candidate_b` `criteria` |
| `track` | track锛堟暣杞ㄨ抗閫愭璇勫垎锛?| `scores` | `problem` `steps` |
| `progress_start` / `progress_update` / `progress_close` | ProgressTracker锛堝湪绾块€愭璇勫垎锛?| `tracker_id` / `score` | 鍒嗚宸ュ叿鎻忚堪 |
| `task_start` | 寮傛鍚姩闀胯瘎鍒嗭紙30min 棰勭畻锛?| `task_id`锛堢珛鍗宠繑鍥烇級 | `method` `params` |
| `task_status` | 杞寮傛浠诲姟锛堣惤鐩樺彲璺ㄩ噸鍚紝鏀寔 `wait_seconds` 闀胯疆璇級 | `status` / `result` | `task_id` |

## 鍥㈤槦闆嗘垚锛堝ぇ鑴?脳 韬共锛?
鎻掍欢鍚戝叏灞€ system prompt 娉ㄥ叆 `verifier-brain:usage` 绛栫暐娈碉紙order 118锛岀揣璺?agent-teams 鐨?117锛夛細

- **Best-of-N**锛氶槦闀挎妸鍚屼竴鍏抽敭浠诲姟娲剧粰澶氫釜鎴愬憳 鈫?鏀堕泦鍚勬垚鍛樻渶缁堜骇鍑?鈫?`verifier select` 鎷╀紭锛屽苟澹版槑鑳滆€呫€?- **Reviewer 闂ㄧ**锛歳eviewer 鎴愬憳鍦ㄤ换鍔℃爣璁板畬鎴愬墠鐢?`verifier compare`锛堝姣旂幇浠绘渶浼橈級楠岃瘉锛涗笉杈炬爣璧?`agent_teams_reassign_task`锛屼笉璁搁潤榛樻斁琛屻€?- **杩涘害浼犳劅鍣?*锛氶暱浠诲姟姣忎釜鎴愬憳姹囨姤鍚?`verifier progress_update`锛涚湡瀹炲伐浣滃悗鎸佺画 <0.05 鈫?鍋滀笅鎹㈢瓥鐣ユ垨閲嶆淳銆?- **鎴愭湰绾緥**锛氶粯璁?`n_evaluations=1`銆乣pivots=2`锛涢鏈熼暱鐨勮瘎鍒嗚蛋寮傛浠诲姟銆?
## 閰嶇疆

| 閰嶇疆椤?| 榛樿 | 璇存槑 |
|---|---|---|
| `pythonBin` | 鑷姩 | 鏄惧紡鎸囧畾 Python锛涚己鐪佹帰娴嬮」鐩?`.venv`锛屽啀閫€鍥?`python` |
| `bridgeTimeoutMs` | `300000` | 鍗曟妗ヨ皟鐢ㄨ秴鏃?|
| `verifierModel` | 鏃?| 榛樿 verifier 妯″瀷锛堟湰鏈洪獙璇佸彲鐢?`deepseek-v4-flash`锛?|
| `backendBaseUrl` / `backendApiKey` | 鍑嵁鑷姩 | 鏄惧紡 OpenAI 鍏煎鍚庣瑕嗙洊 |
| `maxWorkers` | `4` | 妗ュ唴骞跺彂 worker 鏁?|
| `stateDir` | `~/.dsh/verifier-brain` | 鎸佷箙鍖栫洰褰?|
| `promptSection` | `true` | 鏄惁娉ㄥ叆浣跨敤绛栫暐娈?|

鍑嵁澶嶇敤锛氳嚜鍔ㄨ鍙?`~/.dsh/.credentials.yaml`锛岄€忎紶 `DEEPSEEK/VERTEX/GEMINI/OPENAI/OPENROUTER` 閿紱
`OPENCODE_GO_API_KEY` 鑷姩鏄犲皠涓?`OPENAI_API_KEY` + `https://opencode.ai/zen/go/v1`锛堟湰鏈哄凡楠岃瘉璇ョ鐐硅繑鍥?logprobs锛夈€?
## 鍏抽敭鍐崇瓥璁板綍

- **鍏ㄦ柊鐙珛椤圭洰**锛氭ˉ鍗忚涓庡弬鏁扮櫧鍚嶅崟鍚告敹 lanbaolu 宸查獙璇佸疄鐜帮紙criteria 鍏滃簳銆乮mages 闄嶇骇銆佸畼鏂圭鍚嶈繃婊わ級锛?  鏋舵瀯鎸夊ぇ鑴?韬共閲嶆柊璁捐锛屼笉缁ф壙鍏?macOS 鍋囪涓庡唴瀛樻€併€?- **鍚庣閫夋嫨闈犲疄璇?*锛氭湰鏈哄洓涓?OpenAI 鍏煎浠ｇ悊閫愪竴鎺㈡祴 logprobs锛坄scripts/probe_logprobs.py`锛夛紝
  鍙湁 opencode-go 绔偣鐨?`deepseek-v4-flash` 閫氳繃锛汥eepSeek 涓荤珯 key 浣欓涓嶈冻锛?02锛夛紝
  openrouter 涓嶅洖浼?logprobs锛宻ensenova 閰嶉鍙楅檺銆?- **涓嶉噸澶嶅疄鐜板畼鏂圭畻娉?*锛歅ython 闈繚鎸佽杽锛堟牎楠?杞彂/JSON 鍖栵級锛岄噸娲诲叏鍦?`llm-verifier` 鍖呫€?