const { Arch } = require('electron-builder')
const fs = require('fs')
const path = require('path')

const { readProjectBuildMetadata, replacePackagedBetterSqlite3 } = require('./linux-native/compat')

exports.default = async function (context) {
  const platform = context.packager.platform.name
  if (platform === 'windows') {
    fs.rmSync(path.join(context.appOutDir, 'LICENSE.electron.txt'), { force: true })
    fs.rmSync(path.join(context.appOutDir, 'LICENSES.chromium.html'), { force: true })

    // ---- 受管版：强制确保 configure-server.ps1 为 UTF-8 带 BOM ----
    // electron-builder extraResources 复制时偶发剥掉 UTF-8 BOM（EF BB BF），
    // 而 PowerShell 5.1 无 BOM 时按 ANSI/GBK 读 UTF-8 中文 → 乱码 + 语法解析崩溃
    // （实测：ps1 报“缺少右括号/空管道元素”，中文显示为鍙楃鐗?等乱码）。
    // 打包完（afterPack，签章前）用二进制强制写回 BOM，确保任何机器都能正确解析。
    const ps1Path = path.join(context.appOutDir, 'resources', 'sidecar', 'configure-server.ps1')
    if (fs.existsSync(ps1Path)) {
      const buf = fs.readFileSync(ps1Path)
      const bom = Buffer.from([0xef, 0xbb, 0xbf])
      // 已带 BOM 则跳过；否则在头部写入 BOM
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        process.stdout.write('configure-server.ps1 already has UTF-8 BOM, skip\n')
      } else {
        fs.writeFileSync(ps1Path, Buffer.concat([bom, buf]))
        process.stdout.write('configure-server.ps1 BOM restored (EF BB BF prepended)\n')
      }
    } else {
      process.stdout.write('configure-server.ps1 not found at ' + ps1Path + ', skip BOM fix\n')
    }
  } else if (platform === 'linux') {
    const arch = context.arch === Arch.arm64 ? 'arm64' : context.arch === Arch.x64 ? 'x64' : null
    if (!arch) throw new Error(`Unsupported Linux packaging architecture: ${context.arch}`)

    const projectRoot = path.join(__dirname, '..')
    const { destination, manifest } = replacePackagedBetterSqlite3({
      projectRoot,
      appOutDir: context.appOutDir,
      arch,
      metadata: readProjectBuildMetadata(projectRoot)
    })
    process.stdout.write(
      `Installed GLIBC-compatible better-sqlite3 for linux-${arch} at ${destination} ` +
        `(ABI ${manifest.electronAbi}, ${JSON.stringify(manifest.requirements)})\n`
    )
  }
}
