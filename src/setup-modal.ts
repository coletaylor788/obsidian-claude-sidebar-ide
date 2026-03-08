import { App, Modal, Setting, Notice } from "obsidian";
import type { PluginData } from "./types";
import { SpriteManager } from "./sprite-manager";

export class SpritesSetupModal extends Modal {
  private spritesToken = '';
  private onComplete: (spritesToken: string) => void;

  constructor(
    app: App,
    private pluginData: PluginData,
    onComplete: (spritesToken: string) => void,
  ) {
    super(app);
    this.onComplete = onComplete;
    this.spritesToken = pluginData.spritesApiToken || '';
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('sprites-setup-modal');

    contentEl.createEl('h2', { text: 'Cloud Terminal Setup' });
    contentEl.createEl('p', {
      text: 'Configure Sprites.dev to run Claude Code in a cloud VM. This enables terminal access on mobile devices.',
    });

    new Setting(contentEl)
      .setName('Sprites.dev API Token')
      .setDesc('Get your token from sprites.dev/dashboard')
      .addText(text => text
        .setPlaceholder('spr_...')
        .setValue(this.spritesToken)
        .onChange(value => { this.spritesToken = value.trim(); })
        .inputEl.type = 'password'
      );

    const statusEl = contentEl.createDiv({ cls: 'sprites-setup-status' });

    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText('Setup Cloud Terminal')
        .setCta()
        .onClick(async () => {
          if (!this.spritesToken) {
            new Notice('Please enter your Sprites.dev API token');
            return;
          }

          btn.setDisabled(true);
          btn.setButtonText('Setting up...');

          try {
            statusEl.setText('Creating Sprite VM...');
            const manager = new SpriteManager(this.spritesToken, this.app.vault.getName());
            await manager.ensureSprite();

            statusEl.setText('Installing Claude Code CLI...');
            await manager.setupClaudeCode();

            statusEl.setText('Done!');
            new Notice('Cloud terminal ready!');
            this.onComplete(this.spritesToken);
            this.close();
          } catch (err) {
            statusEl.setText(`Error: ${(err as Error).message}`);
            btn.setDisabled(false);
            btn.setButtonText('Retry Setup');
            new Notice(`Setup failed: ${(err as Error).message}`);
          }
        })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
