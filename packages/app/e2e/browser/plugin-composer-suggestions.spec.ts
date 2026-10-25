import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";
import { composerLocator, expectComposerDraftSelection } from "../support/helpers/composer";

test("a plugin shows faint composer text and accepts it with Tab or Right Arrow", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "ghost-composer-",
    title: "Suggested follow-up",
  });
  const client = await connectNewWorkspaceDaemonClient();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-ghost-plugin-"));
  const id = "ghost-composer-e2e";
  const text = "Add focused tests for the new composer API and explain any remaining edge cases.";
  const target = { serverId: getServerId(), agentId: workspace.agentId, text };
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id, requirements: pluginRequirements }),
  );
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `
    export default function contribute(client) {
      const target = ${JSON.stringify(target)};
      let active = true;
      let removeSuggestion = () => {};
      async function suggest() {
        if (!client.composer?.suggestText) throw new Error("Suggestion API missing");
        const result = await client.composer.suggestText(target);
        if (result.status === "suggested") {
          if (!active) result.remove();
          else removeSuggestion = result.remove;
        }
        header.update({ label: result.status });
      }
      const header = client.addHeaderButton({ id: "suggest", workspaceId: ${JSON.stringify(workspace.workspaceId)},
        button: { title: "Show follow-up suggestion", label: "Suggest", icon: "MessageSquare",
          behavior: { kind: "action", onPress: suggest } } });
      void suggest();
      return () => { active = false; removeSuggestion(); header.remove(); };
    }
  `,
  );
  try {
    await openAgentRoute(page, workspace);
    const composer = composerLocator(page);
    await expect(composer).toBeEditable();
    await composer.blur();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const offer = page.getByRole("button", { name: "Show follow-up suggestion", exact: true });
    await expect(offer).toContainText("suggested");
    await expect(composer).toHaveAttribute("placeholder", text);
    await expect(composer).toHaveValue("");
    await expect(composer).not.toBeFocused();
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
    await testInfo.attach("ghost-before-acceptance", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await composer.focus();
    await composer.press("Tab");
    await expect(composer).toHaveValue(text);
    await expect(composer).toBeFocused();
    await expectComposerDraftSelection(page, text.length, text.length);
    await composer.pressSequentially(" Also cover attachments.");
    await expect(composer).toHaveValue(text + " Also cover attachments.");
    await offer.click();
    await expect(offer).toContainText("draft-not-empty");
    await expect(composer).toHaveValue(text + " Also cover attachments.");
    await page.reload();
    await expect(composer).toHaveValue(text + " Also cover attachments.");
    await composer.fill("");
    await offer.click();
    await expect(offer).toContainText("suggested");
    await composer.focus();
    await composer.press("ArrowRight");
    await expect(composer).toHaveValue(text);
    await expectComposerDraftSelection(page, text.length, text.length);
    await testInfo.attach("accepted-editable-draft", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await composer.fill("");
    await offer.click();
    await composer.focus();
    await composer.pressSequentially("My own prompt");
    await expect(composer).toHaveValue("My own prompt");
    await expect(composer).not.toHaveAttribute("placeholder", text);
    await composer.fill("");
    await offer.click();
    await composer.focus();
    await composer.press("Escape");
    await expect(composer).toHaveValue("");
    await expect(composer).not.toHaveAttribute("placeholder", text);
    await offer.click();
    await client.removePlugin(id);
    await expect(composer).not.toHaveAttribute("placeholder", text);
    const agents = await workspace.client.fetchAgents();
    expect(
      agents.entries.find((entry) => entry.agent.id === workspace.agentId)?.agent.status,
    ).not.toBe("running");
  } finally {
    await client.removePlugin(id).catch(() => {});
    await client.close();
    await workspace.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});
