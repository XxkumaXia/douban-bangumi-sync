# -*- coding: utf-8 -*-
"""把扩展打包成可以发给别人的 zip，并做分发前自检。

用法：
    python tools/pack.py                       # 默认从 F:\\豆瓣 bangumi脚本 打到 F:\\
    python tools/pack.py --src . --out dist    # 指定源目录与输出目录

分发最常见的三种翻车：
  1. 漏文件 —— manifest 里写的 service worker / popup / options 页没打进去，装了就报错
  2. HTML 引用的 css/js 没打进去 —— 页面白屏，但扩展图标点得开，最难查
  3. 把开发垃圾（tests / node_modules / 个人配置）一起发出去
所以打包干三件事：只收该收的、把前两类引用逐个核对、保证 JS 的相对 import 也齐全。
"""
import argparse
import io
import json
import os
import re
import shutil
import sys
import zipfile

TOP_FILES = ["manifest.json", "README.md", "LICENSE"]
# README 会链到 docs/ 下的说明，得一起带上，否则包里的链接全是死链；
# MIT 也要求分发时附带许可声明，所以 LICENSE 必收。
EXTRA_FILES = ["docs/USAGE.md", "docs/TROUBLESHOOTING.md"]
TOP_DIRS = ["src", "icons"]
SKIP = {"__pycache__", ".DS_Store", "Thumbs.db"}

INSTALL_TXT = """豆瓣 ↔ Bangumi 观影同步 —— 安装说明
=====================================

一、安装（Chrome / Edge / 其他 Chromium 内核浏览器）
-----------------------------------------------
1. 把本压缩包解压到一个**固定不动**的文件夹
   （别放在桌面临时目录、别解压完又去删，扩展是按路径读取的，文件没了扩展就失效）
2. 浏览器打开  chrome://extensions   （Edge 是 edge://extensions）
3. 打开右上角的「开发者模式」
4. 点左上角「加载已解压的扩展程序」，选中**解压出来的那个文件夹**
   —— 注意要选到里面直接看得到 manifest.json 的那一层
5. 工具栏出现扩展图标即成功；建议点图标旁的图钉把它固定出来

为什么是这种方式：Chrome 从 73 版本起，除了官方应用商店，不再允许双击 crx 直接安装。
这个扩展没有上架商店，所以走「开发者模式加载」是唯一可行的路。

二、安装后必做
--------------
1. 在浏览器里**登录豆瓣**（随便打开一个豆瓣页面）
2. 申请 Bangumi 个人访问令牌，填进扩展设置页
3. 按 README.md「三、首次使用」的顺序：接口自检 → 扫描两侧 → 自动匹配 → 演练 → 执行
   先演练再执行，演练不会真的写入任何东西

三、常见问题
------------
· 浏览器提示「请停用开发者模式运行的扩展程序」
  这是 Chrome 对所有非商店扩展的统一提示，不是本扩展有问题。
· 更新到新版本
  把新包解压覆盖到**同一个文件夹**，然后回到 chrome://extensions 点扩展卡片上的刷新箭头。
  路径一变，浏览器会当成一个新扩展，之前的设置和映射表就没了。
· 设置和凭据会跟着走吗
  不会。豆瓣登录态读的是浏览器自己的 cookie，Bangumi 令牌存在浏览器的扩展存储里，
  所以换电脑要重新配置 —— 这也意味着这个包里不含任何人的个人信息。

四、隐私说明
------------
本扩展所有数据只在本机处理：直接请求豆瓣和 Bangumi 的接口，不经任何第三方服务器。
源码一并打包在 src/ 下，可以自己检查有没有多余的网络请求。

更详细的说明（同步规则、评分换算、排障）见 README.md。
"""


def build_tree(src, build):
    """只搬扩展真正需要的东西 —— 其余（tests / node_modules / 个人配置）一律不进包"""
    missing_top = [f for f in TOP_FILES + EXTRA_FILES if not os.path.exists(os.path.join(src, f))]
    if missing_top:
        sys.exit("源目录缺少必须文件：%s" % ", ".join(missing_top))

    if os.path.exists(build):
        shutil.rmtree(build)
    os.makedirs(build)
    for f in TOP_FILES:
        shutil.copy2(os.path.join(src, f), os.path.join(build, f))
    for f in EXTRA_FILES:
        dst = os.path.join(build, f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(src, f), dst)
    for d in TOP_DIRS:
        shutil.copytree(
            os.path.join(src, d),
            os.path.join(build, d),
            ignore=lambda _dir, names: [n for n in names if n in SKIP],
        )
    with io.open(os.path.join(build, "安装说明.txt"), "w", encoding="utf-8") as fh:
        fh.write(INSTALL_TXT)


def check_manifest_refs(build, mf, problems):
    refs = [mf["background"]["service_worker"], mf["action"]["default_popup"], mf["options_ui"]["page"]]
    for group in (mf["action"].get("default_icon", {}), mf.get("icons", {})):
        refs += list(group.values())
    missing = [r for r in refs if not os.path.exists(os.path.join(build, r))]
    print("manifest 引用的资源：%d 个" % len(refs))
    if missing:
        problems.append("manifest 引用了包里不存在的文件：" + ", ".join(missing))


def check_html_refs(build, problems):
    """HTML 里 src/href 的本地文件必须都在 —— 漏一个就是页面白屏"""
    total = 0
    for root, _dirs, files in os.walk(build):
        for f in files:
            if not f.endswith(".html"):
                continue
            path = os.path.join(root, f)
            html = io.open(path, encoding="utf-8").read()
            refs = re.findall(r'(?:src|href)="([^"]+)"', html)
            refs = [r for r in refs if not r.startswith(("http", "#", "data:", "//", "mailto:"))]
            for r in refs:
                total += 1
                target = os.path.normpath(os.path.join(root, r.split("?")[0].split("#")[0]))
                if not os.path.exists(target):
                    problems.append("%s 引用了不存在的 %s" % (os.path.relpath(path, build), r))
    print("HTML 里的本地引用：%d 个" % total)


def ensure_local_imports_exist(build, problems):
    """JS 里相对 import 的文件也必须都在 —— 漏一个就是 service worker 直接起不来"""
    total = 0
    for root, _dirs, files in os.walk(os.path.join(build, "src")):
        for f in files:
            if not f.endswith(".js"):
                continue
            path = os.path.join(root, f)
            code = io.open(path, encoding="utf-8").read()
            for spec in re.findall(r"""from\s+['"](\.[^'"]+)['"]""", code):
                total += 1
                target = os.path.normpath(os.path.join(root, spec))
                if not os.path.exists(target):
                    problems.append("%s import 了不存在的 %s" % (os.path.relpath(path, build), spec))
    print("JS 里的相对 import：%d 个" % total)


def make_zip(build, out_dir, version):
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, "douban-bangumi-sync-v%s.zip" % version)
    n = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _dirs, files in os.walk(build):
            for f in sorted(files):
                full = os.path.join(root, f)
                z.write(full, os.path.relpath(full, build))
                n += 1
    return out, n


def main():
    ap = argparse.ArgumentParser(description="打包豆瓣↔Bangumi 同步扩展")
    ap.add_argument("--src", default="F:/豆瓣 bangumi脚本", help="扩展源码目录")
    ap.add_argument("--out", default="F:/", help="zip 输出目录")
    ap.add_argument("--build", default=os.path.join(os.environ.get("TEMP", "/tmp"), "dbbgm-pkg"))
    a = ap.parse_args()

    problems = []
    build_tree(a.src, a.build)
    mf = json.load(io.open(os.path.join(a.build, "manifest.json"), encoding="utf-8"))
    version = mf["version"]
    print("版本：%s" % version)

    check_manifest_refs(a.build, mf, problems)
    check_html_refs(a.build, problems)
    ensure_local_imports_exist(a.build, problems)

    packed = [f for r, _d, fs in os.walk(a.build) for f in fs]
    print("打包文件数：%d" % len(packed))

    if problems:
        print("自检未通过：")
        for p in problems:
            print("  x " + p)
        sys.exit(1)

    out, n = make_zip(a.build, a.out, version)
    print("已生成：%s（%d 个文件，%.1f KB）" % (out, n, os.path.getsize(out) / 1024.0))


if __name__ == "__main__":
    main()
