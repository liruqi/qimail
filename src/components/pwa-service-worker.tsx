"use client";

import { useEffect } from "react";
import { registerQimailServiceWorker } from "@/lib/push/client";

export function PwaServiceWorker() {
	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		void registerQimailServiceWorker().catch((error) => {
			console.warn("Qimail service worker registration failed", error);
		});
	}, []);

	return null;
}
