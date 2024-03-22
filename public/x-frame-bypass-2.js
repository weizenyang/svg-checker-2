customElements.define('x-frame-bypass', class extends HTMLIFrameElement {
	static get observedAttributes() {
	  return ['src'];
	}
  
	constructor() {
	  super();
	  this.historyEvents = [];
	  this.maxHistoryEvents = 3; // Adjust the number of events to wait for
	}
  
	attributeChangedCallback() {
	  this.load(this.src);
	}
  
	connectedCallback() {
	  this.sandbox =
		'' + this.sandbox ||
		'allow-forms allow-modals allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts allow-top-navigation-by-user-activation'; // all except allow-top-navigation
	}
  
	load(url, options) {
	  if (!url || !url.startsWith('http'))
		throw new Error(`X-Frame-Bypass src ${url} does not start with http(s)://`);
	  console.log('X-Frame-Bypass loading:', url);
  
	  // ... (existing code)
  
	  // Fetch content and handle events
	  this.fetchProxy(url, options, 0)
		.then((res) => res.text())
		.then((data) => {
		  if (data) {
			// ... (existing code)
  
			// X-Frame-Bypass navigation event handlers
			document.addEventListener('click', (e) => {
			  this.handleNavigationEvent(e);
			});
  
			document.addEventListener('submit', (e) => {
			  this.handleNavigationEvent(e);
			});
		  }
		})
		.catch((e) => console.error('Cannot load X-Frame-Bypass:', e));
	}
  
	handleNavigationEvent(event) {
	  if (frameElement && document.activeElement && document.activeElement.href) {
		// Store the URL and check if enough events have occurred
		this.historyEvents.push(document.activeElement.href);
		if (this.historyEvents.length >= this.maxHistoryEvents) {
		  this.historyEvents = []; // Reset the array for the next load
		  event.preventDefault();
		  frameElement.load(document.activeElement.href);
		}
	  }
	}
  
	fetchProxy(url, options, i) {
	  const proxies = (options || {}).proxies || [
		// 'https://cors-anywhere.herokuapp.com/',
		// 'https://yacdn.org/proxy/',
		'http://localhost:8080/',
		// 'https://api.codetabs.com/v1/proxy/?quest='
	  ];
	  return fetch(proxies[i] + url, options)
		.then((res) => {
		  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		  return res;
		})
		.catch((error) => {
		  if (i === proxies.length - 1) throw error;
		  return this.fetchProxy(url, options, i + 1);
		});
	}
  }, { extends: 'iframe' });