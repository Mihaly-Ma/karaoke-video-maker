"""端到端联调：走一遍真实工作流，验证 17 个 agent 的产出能协同工作。"""

import os
import sys
import tempfile
from pathlib import Path

REPO = Path("/Users/Mihaly/projects/karaoke-video-maker/.claude/worktrees/init-claude-md")
sys.path.insert(0, str(REPO / "backend"))
sys.path.insert(0, str(REPO))

DATA = tempfile.mkdtemp(prefix="kvm-e2e-")
os.environ["KVM_DATA_DIR"] = str(Path(DATA) / "projects")

from fastapi.testclient import TestClient  # noqa: E402

from kvm.api.app import app  # noqa: E402

ok = 0
fail = 0


def check(label: str, cond: bool, extra: str = "") -> None:
    global ok, fail
    if cond:
        ok += 1
        print(f"  ✅ {label} {extra}")
    else:
        fail += 1
        print(f"  ❌ {label} {extra}")


with TestClient(app) as c:
    print("=== 1. 工程生命周期 ===")
    r = c.post("/api/projects/", json={"title": "赤春花", "artist": "sumika"})
    check("创建工程", r.status_code in (200, 201), f"HTTP {r.status_code}")
    pid = r.json()["id"]

    r = c.get(f"/api/projects/{pid}")
    check("读取工程", r.status_code == 200 and r.json()["title"] == "赤春花")

    print("\n=== 2. 导入真实 QRC 歌词 ===")
    qrc = (REPO / "workspace/qrc/lyric_content.qrc").read_text(encoding="utf-8")
    r = c.post(
        "/api/lyrics/import",
        json={"project_id": pid, "kind": "qrc", "content": qrc, "replace": True},
    )
    check("导入 QRC", r.status_code == 200, f"HTTP {r.status_code}")
    if r.status_code != 200:
        print("     ", r.text[:300])
    else:
        proj = r.json()
        lines = proj["lines"]
        body = [ln for ln in lines if not ln["is_metadata"]]
        ruby_n = sum(len(ln["ruby"]) for ln in lines)
        tids = [t["tid"] for ln in lines for t in ln["tokens"]]
        check("行数", len(lines) == 60, f"{len(lines)} 行（正文 {len(body)}）")
        check("注音", ruby_n > 100, f"{ruby_n} 段")
        check("tid 已生成", all(tids) and len(tids) > 600, f"{len(tids)} 个 token")

    print("\n=== 3. 纯文本导入的 unset 语义 ===")
    r2 = c.post("/api/projects/", json={"title": "文本测试"})
    pid2 = r2.json()["id"]
    r = c.post(
        "/api/lyrics/import",
        json={"project_id": pid2, "kind": "text", "content": "一行歌词\n二行歌词", "replace": True},
    )
    if r.status_code == 200:
        srcs = {t["timing_source"] for ln in r.json()["lines"] for t in ln["tokens"]}
        check("纯文本标 unset", srcs == {"unset"}, f"实际 {srcs}")
    else:
        check("纯文本导入", False, f"HTTP {r.status_code} {r.text[:200]}")

    print("\n=== 4. 三级调轴 ===")
    proj = c.get(f"/api/projects/{pid}").json()
    body = [ln for ln in proj["lines"] if not ln["is_metadata"] and ln["tokens"]]
    lid = body[0]["id"]

    r = c.post("/api/editor/shift", json={
        "project_id": pid, "scope": "global", "delta_ms": 62,
        "line_id": None, "token_index": None})
    check("整体平移", r.status_code == 200 and r.json()["global_offset_ms"] == 62,
          f"offset={r.json().get('global_offset_ms') if r.status_code==200 else r.status_code}")

    before = c.get(f"/api/projects/{pid}").json()
    tok0 = [ln for ln in before["lines"] if ln["id"] == lid][0]["tokens"][0]["start_ms"]
    r = c.post("/api/editor/shift", json={
        "project_id": pid, "scope": "line", "delta_ms": 100,
        "line_id": lid, "token_index": None})
    if r.status_code == 200:
        after = [ln for ln in r.json()["lines"] if ln["id"] == lid][0]["tokens"][0]
        check("单句平移", after["start_ms"] == tok0 + 100, f"{tok0} → {after['start_ms']}")
        check("平移后标 manual+locked",
              after["timing_source"] == "manual" and after["locked_timing"])
    else:
        check("单句平移", False, f"HTTP {r.status_code} {r.text[:200]}")

    print("\n=== 5. 批量调轴（一个 undo 单元）===")
    h0 = c.get(f"/api/projects/{pid}/history").json()["undo"]
    edits = [{"line_id": lid, "token_index": i, "start_ms": 1000 + i * 200, "dur_ms": 180}
             for i in range(3)]
    r = c.post("/api/editor/timings", json={"project_id": pid, "items": edits})
    if r.status_code != 200:
        r = c.post("/api/editor/timings", json={"project_id": pid, "edits": edits})
    h1 = c.get(f"/api/projects/{pid}/history").json()["undo"]
    check("批量调轴", r.status_code == 200, f"HTTP {r.status_code}")
    check("整批仅占一格撤销", h1 - h0 == 1, f"撤销栈 {h0} → {h1}")

    print("\n=== 6. 撤销 / 重做 ===")
    r = c.post(f"/api/projects/{pid}/undo", json={})
    check("撤销", r.status_code == 200)
    r = c.post(f"/api/projects/{pid}/redo", json={})
    check("重做", r.status_code == 200)

    print("\n=== 7. 注音编辑 ===")
    r = c.post("/api/editor/ruby", json={
        "project_id": pid, "line_id": lid, "start": 0, "end": 1, "text": "テスト"})
    if r.status_code == 200:
        rl = [ln for ln in r.json()["lines"] if ln["id"] == lid][0]
        hit = [x for x in rl["ruby"] if x["start"] == 0 and x["end"] == 1]
        check("设定注音", bool(hit) and hit[0]["text"] == "テスト")
        check("注音标 manual+locked",
              bool(hit) and hit[0]["source"] == "manual" and hit[0]["locked"])
    else:
        check("设定注音", False, f"HTTP {r.status_code} {r.text[:200]}")

    print("\n=== 8. Token 级声部 ===")
    r = c.post("/api/editor/voice-part", json={
        "project_id": pid, "line_id": lid, "voice_part": "duet_a", "token_range": [0, 2]})
    if r.status_code == 200:
        vl = [ln for ln in r.json()["lines"] if ln["id"] == lid][0]
        vps = [t.get("voice_part") for t in vl["tokens"][:3]]
        check("区间声部不拆行", len(r.json()["lines"]) == len(proj["lines"]),
              f"行数 {len(proj['lines'])} → {len(r.json()['lines'])}")
        check("token 声部已写入", vps[0] == "duet_a" and vps[1] == "duet_a", f"{vps}")
    else:
        check("区间声部", False, f"HTTP {r.status_code} {r.text[:200]}")

    print("\n=== 9. 配色方案 ===")
    # 方案 = 一组四色，不带声部（声部名由用户自定义，写死会让取色全部落空）
    r = c.get("/api/palettes/schemes")
    check("列出方案", r.status_code == 200, f"{len(r.json()) if r.status_code==200 else '?'} 套")
    if r.status_code == 200 and r.json():
        first = r.json()[0]
        r = c.post("/api/palettes/schemes", json={"name": "我的配色", "colors": first["colors"]})
        check("保存自定义方案", r.status_code in (200, 201), f"HTTP {r.status_code}")
        # 用一个用户自定义的声部名施加，确认任意名字都取得到色
        r = c.post(f"/api/projects/{pid}/palettes",
                   json={"scheme": first["name"], "apply_to": "男"})
        ok_apply = (r.status_code == 200
                    and r.json()["palettes"]["男"]["sung_fill"] == first["colors"]["sung_fill"])
        check("方案施加到自定义声部", ok_apply, f"HTTP {r.status_code}")

    print("\n=== 10. 字体服务 ===")
    # 字体扫描是后台异步的（冷启动约 33s，热启动 17ms）——必须等它 ready 再断言，
    # 否则拿到的是扫描中的部分结果。任何"挂载时只拉一次"的消费方都会踩这个坑。
    import time as _t
    _deadline = _t.time() + 90
    while _t.time() < _deadline:
        st = c.get("/api/fonts/status").json()
        if st.get("state") in ("ready", "failed"):
            break
        _t.sleep(1)
    st = c.get("/api/fonts/status").json()
    check("字体扫描就绪", st.get("state") == "ready",
          f"{st.get('state')} / {st.get('family_count')} 族")
    r = c.get("/api/fonts/presets")
    if r.status_code == 200:
        ps = r.json()
        hit = [p for p in ps if p.get("resolved")]
        check("字体预置", len(hit) == 4, f"{len(hit)}/{len(ps)} 档可用: " +
              ", ".join(f"{p['label']}→{p['resolved']}" for p in hit))
    else:
        check("字体预置", False, f"HTTP {r.status_code}")

    print("\n=== 11. 生成 ASS（渲染闭环）===")
    r = c.post("/api/render/ass", json={"project_id": pid})
    if r.status_code == 200:
        d = r.json()
        ass = d["ass"]
        check("生成 ASS", d["event_count"] > 300, f"{d['event_count']} 个事件")
        check("含双层 clip 扫描", "\\t(" in ass and "\\clip(" in ass)
        check("含注音行", "Ruby," in ass)
        check("含引导点", "Dot," in ass)
        check("含制作名单", "Title," in ass)
    else:
        check("生成 ASS", False, f"HTTP {r.status_code} {r.text[:300]}")

print(f"\n{'=' * 50}")
print(f"通过 {ok}　失败 {fail}")
sys.exit(1 if fail else 0)
