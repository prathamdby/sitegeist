import { ProviderKeyInput } from "../../src/components/ProviderKeyInput.js";
import { getModel } from "../../src/pi/models.js";
import { getAppStorage, SitegeistAppStorage, setAppStorage } from "../../src/storage/app-storage.js";

const fixture = {
	model(provider: string, id: string) {
		return getModel(provider, id);
	},
	async mount(provider: string) {
		const input = new ProviderKeyInput();
		input.provider = provider;
		document.body.replaceChildren(input);
		await input.updateComplete;
		return true;
	},
	readKey(provider: string) {
		return getAppStorage().providerKeys.get(provider);
	},
	setKey(provider: string, value: string) {
		return getAppStorage().providerKeys.set(provider, value);
	},
	async setProxy(enabled: boolean, url: string) {
		await getAppStorage().settings.set("proxy.enabled", enabled);
		await getAppStorage().settings.set("proxy.url", url);
	},
};

declare global {
	interface Window {
		authFixture: typeof fixture;
	}
}

setAppStorage(new SitegeistAppStorage());
window.authFixture = fixture;
