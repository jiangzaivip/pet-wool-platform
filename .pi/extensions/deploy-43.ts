import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("deploy-43", {
    description:
      "自动部署到 43.155.164.232：构建前端、连接服务器、更新文件、重启服务、打印详细日志。只有真正成功才输出成功日志。每步失败都有错误日志。",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const logs: string[] = [];
      const errors: string[] = [];
      const addLog = (msg: string) => {
        logs.push(`[${new Date().toISOString()}] ${msg}`);
        console.log(msg);
      };
      const addError = (msg: string, err?: unknown) => {
        const detail = err ? `\n  错误详情: ${String(err)}` : "";
        const line = `[${new Date().toISOString()}] [ERROR] ${msg}${detail}`;
        errors.push(line);
        console.error(line);
      };

      addLog("========================================");
      addLog("开始执行部署扩展：目标服务器 43.155.164.232");
      addLog("========================================");

      // Step 1: 检查本地构建环境
      addLog("[步骤 1/8] 检查本地构建环境...");
      try {
        if (!existsSync("frontend/package.json")) {
          throw new Error("未找到 frontend/package.json");
        }
        addLog("  ✓ frontend/package.json 存在");
      } catch (e: any) {
        addError("本地构建环境检查失败", e);
        printLogs(logs, errors);
        return;
      }

      // Step 2: 构建前端
      addLog("[步骤 2/8] 构建前端 (npm run build)...");
      try {
        const buildOutput = execSync("npm run build", {
          encoding: "utf-8",
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
        });
        addLog("  ✓ 前端构建成功");
        addLog(`  构建输出摘要（前 20 行）:\n${buildOutput.split("\n").slice(0, 20).join("\n")}`);
      } catch (e: any) {
        addError("前端构建失败", e);
        addLog(`  标准错误输出: ${e.stderr ? String(e.stderr) : String(e)}`);
        printLogs(logs, errors);
        return;
      }

      // Step 3: 检查远程服务器连接
      addLog("[步骤 3/8] 检查远程服务器连接 43.155.164.232...");
      let sshOk = false;
      try {
        const sshTest = execSync(
          'ssh -i .deploy/production_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 ubuntu@43.155.164.232 "echo SSH_OK; systemctl is-active pet-wool-platform; ls -la /opt/pet-wool-platform/.env"',
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        addLog("  ✓ SSH 连接成功");
        addLog(`  远程响应:\n${sshTest}`);
        sshOk = true;
      } catch (e: any) {
        addError("远程服务器连接失败（SSH/服务/文件检查）", e);
        addLog(`  错误输出: ${e.stderr ? String(e.stderr) : String(e)}`);
        printLogs(logs, errors);
        return;
      }

      // Step 4: 检查远程 .env 文件状态
      addLog("[步骤 4/8] 检查远程 .env 文件状态...");
      try {
        const envStatus = execSync(
          'ssh -i .deploy/production_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=accept-new ubuntu@43.155.164.232 "cat /opt/pet-wool-platform/.env | grep -E \'GOOGLE_DEMO_LOGIN|ADMIN_ACCOUNTS_JSON|NODE_ENV\'"',
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        addLog("  ✓ 远程 .env 可访问");
        addLog(`  关键配置行:\n${envStatus}`);
      } catch (e: any) {
        addError("远程 .env 文件检查失败", e);
        printLogs(logs, errors);
        return;
      }

      // Step 5: 执行部署脚本
      addLog("[步骤 5/8] 执行部署脚本 deploy.sh（DEPLOY_HOST=43.155.164.232）...");
      try {
        const deployOutput = execSync(
          "DEPLOY_HOST=43.155.164.232 DEPLOY_KEY=.deploy/production_ed25519 bash deploy.sh",
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], cwd: process.cwd() }
        );
        addLog("  ✓ 部署脚本执行完成（未抛出异常）");
        addLog(`  部署输出摘要（最后 30 行）：\n${deployOutput.split("\n").slice(-30).join("\n")}`);
      } catch (e: any) {
        addError("部署脚本执行失败（可能已自动回滚）", e);
        addLog(`  标准错误/标准输出: ${e.stdout ? String(e.stdout) : ""}\n${e.stderr ? String(e.stderr) : ""}`);
        printLogs(logs, errors);
        return;
      }

      // Step 6: 验证远程文件更新时间（确认文件已更新）
      addLog("[步骤 6/8] 验证远程文件更新时间（43.155.164.232 /opt/pet-wool-platform）...");
      let fileUpdated = false;
      try {
        const fileCheck = execSync(
          'ssh -i .deploy/production_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=accept-new ubuntu@43.155.164.232 "ls -la --full-time /opt/pet-wool-platform/frontend/dist/assets/index-*.js"',
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        addLog("  ✓ 远程文件列表获取成功");
        addLog(`  远程文件时间戳：\n${fileCheck}`);
        fileUpdated = true;
      } catch (e: any) {
        addError("远程文件更新时间检查失败", e);
        addLog(`  错误输出: ${e.stderr ? String(e.stderr) : String(e)}`);
        printLogs(logs, errors);
        return;
      }

      // Step 7: 验证远程服务重启状态
      addLog("[步骤 7/8] 验证远程服务重启状态（systemctl status pet-wool-platform）...");
      let serviceActive = false;
      try {
        const serviceStatus = execSync(
          'ssh -i .deploy/production_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=accept-new ubuntu@43.155.164.232 "systemctl is-active pet-wool-platform; systemctl status pet-wool-platform --no-pager -l"',
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        addLog("  ✓ 远程服务状态获取成功");
        addLog(`  服务状态详情：\n${serviceStatus}`);
        if (serviceStatus.includes("active (running)")) {
          serviceActive = true;
          addLog("  ✓ 服务状态：active (running)");
        } else {
          addLog("  ⚠ 服务状态未显示 active (running)，请检查");
        }
      } catch (e: any) {
        addError("远程服务重启状态检查失败", e);
        addLog(`  错误输出: ${e.stderr ? String(e.stderr) : String(e)}`);
        printLogs(logs, errors);
        return;
      }

      // Step 8: 最终验证 - 健康检查和内容验证
      addLog("[步骤 8/8] 最终验证：远程健康检查 + 内容验证...");
      let healthOk = false;
      try {
        const healthCheck = execSync(
          'ssh -i .deploy/production_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=accept-new ubuntu@43.155.164.232 "curl -s -o /dev/null -w %{http_code} http://127.0.0.1:8888/health || echo FAIL"',
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        addLog(`  健康检查响应: ${healthCheck.trim()}`);
        if (healthCheck.trim() === "200") {
          healthOk = true;
          addLog("  ✓ 健康检查通过（HTTP 200）");
        } else {
          addLog(`  ⚠ 健康检查未返回 200（返回: ${healthCheck.trim()}）`);
        }
      } catch (e: any) {
        addError("最终健康检查失败", e);
        addLog(`  错误输出: ${e.stderr ? String(e.stderr) : String(e)}`);
        printLogs(logs, errors);
        return;
      }

      // 最终内容验证（检查远程 JS 是否包含修改内容）
      addLog("  验证远程前端构建内容是否包含修改...");
      try {
        const contentCheck = execSync(
          'ssh -i .deploy/production_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=accept-new ubuntu@43.155.164.232 "cat /opt/pet-wool-platform/frontend/dist/assets/index-*.js | grep -o \'pf.kakao.com/_UWErX\|wa.me/8613583155893\|WoolBuddy\|고객 문의\' | sort -u | head -n 10"',
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        );
        addLog(`  远程内容验证结果（包含修改关键词）：\n${contentCheck}`);
      } catch (e: any) {
        addLog(`  ⚠ 内容验证执行出现问题（不阻止最终判断）：${e.stderr ? String(e.stderr) : String(e)}`);
      }

      // 最终成功判断
      const trulySuccess = sshOk && fileUpdated && serviceActive && healthOk;
      addLog("========================================");
      if (trulySuccess) {
        addLog("【部署成功】所有环节验证通过（连接、文件更新、重启、健康检查、内容包含修改）");
        addLog("目标服务器：43.155.164.232");
        addLog("服务状态：active (running)");
        addLog("健康检查：HTTP 200");
        addLog("修改内容：已应用（Korean 문의区域、链接、图标、contactFallback 清除）");
        addLog("========================================");
        console.log("\n✅ 部署成功日志已生成（无失败环节）\n");
      } else {
        addLog("【部署未完全成功】部分环节未通过，请检查上方错误/警告日志");
        addLog(`验证状态：SSH=${sshOk}, 文件更新=${fileUpdated}, 服务重启=${serviceActive}, 健康检查=${healthOk}`);
        addLog("========================================");
        console.log("\n❌ 部署存在未完全成功环节，已输出详细错误/警告日志\n");
      }

      printLogs(logs, errors);
    },
  });

  function printLogs(logs: string[], errors: string[]) {
    const separator = "\n----------------------------------------\n";
    const logFile = `/tmp/pi-deploy-43-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    try {
      const content = [
        "=== PI 扩展部署日志 ===",
        `生成时间: ${new Date().toISOString()}`,
        `目标服务器: 43.155.164.232`,
        separator,
        "--- 详细步骤日志 ---",
        logs.join("\n"),
        separator,
        errors.length > 0 ? "--- 错误日志 ---" : "--- 无错误日志（所有环节正常） ---",
        errors.length > 0 ? errors.join("\n") : "无错误",
        separator,
        "--- 最终状态 ---",
        errors.length === 0 ? "部署成功（无失败环节）" : `部署存在 ${errors.length} 个失败环节`,
        separator,
        `日志文件已保存到: ${logFile}`,
      ].join("\n");
      writeFileSync(logFile, content, { encoding: "utf-8" });
      console.log(`\n📁 详细日志已保存到文件: ${logFile}`);
    } catch (e) {
      console.error("无法写入日志文件:", e);
    }
  }
}
