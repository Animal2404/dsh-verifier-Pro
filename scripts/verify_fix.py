#!/usr/bin/env python3
"""Verify the fix: tagged-client path (skip vLLM-only prefill) via the
official llm_verifier.compare, on the real articles from 111.txt."""
import os

import llm_verifier
from llm_verifier import fine_grained_reward as fgr

BASE_URL = os.environ["VB_BASE_URL"]
API_KEY = os.environ["VB_KEY"]
MODEL = os.environ.get("VB_MODEL", "deepseek-v4-flash")

A = "现在人工智能很火，很多人担心以后没有工作可做了。其实我觉得，人工智能虽然会改变工作，但不一定会让大家都失业。原因很简单，因为每次技术革命都创造了新工作。历史上，工业革命的时候，很多农民失去了土地，但后来工厂需要工人，服务业也发展起来了。现在人工智能也一样，它会替代一些简单的工作，比如客服、翻译这些，但同时也会出现新的职业，比如提示词工程师、AI训练师这些以前没有的岗位。所以，长期来看，工作机会可能还会增加。另外，人工智能可以帮我们提高效率。比如医生用AI辅助看片子，程序员用AI写代码，都能节省时间。这样人就可以做更重要的事情，比如和病人沟通、设计复杂的系统。但这需要人们学会使用AI工具，不然可能会被淘汰。当然，这个过程中会有一些问题，比如年纪大的人可能不适应新技术，有些公司会裁员。所以政府和企业要提供培训，帮助大家学习新技能。学校也应该教学生怎么和AI合作，而不是只学死知识。总之，人工智能不会完全取代人类，但我们需要不断学习，适应变化。这样技术才能为我们服务，而不是让我们失业。"
C = "AI发展这么快，大家都说工作要没了。但我觉得不一定，因为技术一直进步，以前马车夫也没了，但司机出现了。所以AI也会这样。AI能做一些事，但不能做所有事。比如，AI不会思考，没有感情，很多工作它做不了，像老师教学生，护士照顾病人，这些都需要人。而且AI也会创造工作，比如写AI的代码需要人，修AI的机器也需要人。所以工作还是会有的。但是，AI也有坏处，它会让一些人失业，特别是那些做简单事情的人。这些人可能找不到新工作，因为年龄大了，学不会新东西。国家应该管一管，给钱或者培训，不然社会会不稳定。还有就是，AI虽然好，但也会出错，比如自动驾驶撞车了怎么办？所以人类还是要控制AI，不能全交给它。反正我觉得，AI不会让所有人都没工作，但会改变工作的样子。我们只能适应，不然就麻烦了。就这样吧。"
GIBBERISH = "asdkjh qwerty 12345 %%% zzzz ??? ai work job no yes maybe 42 hello world foo bar baz."

client = fgr.create_openai_client(base_url=BASE_URL, api_key=API_KEY)
client._llm_verifier_deepseek = True  # the fix: read the model's own score tags

criteria = {"Overall": "Which passage makes a better, evidence-based argument about AI and jobs?"}

print(f"=== tagged-client compare, model={MODEL}, effort={os.environ.get('DEEPSEEK_EFFORT', '<default>')}")
for name, b in [("A vs GIBBERISH", GIBBERISH), ("A vs C", C)]:
    ra, rb = llm_verifier.compare(f"Which is a better essay about AI and jobs?", A, b,
                                  criteria=criteria, client=client, model=MODEL,
                                  n_evaluations=1)
    verdict = "OK" if ra > rb else ("TIE" if ra == rb else "INVERTED")
    print(f"{name}: reward_a={ra:.4f} reward_b={rb:.4f}  [{verdict}]")
