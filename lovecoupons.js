import { Actor } from 'apify';
import { CheerioCrawler, RequestList } from 'crawlee';
import cheerio from 'cheerio';

async function main() {
    await Actor.init();

    // Get input URLs from Apify input - now expecting direct brand URLs
    const input = await Actor.getInput();
    const startUrls = input.urls.map(url => ({
        url,
        userData: { label: 'BRAND_DETAIL' }
    }));

    const crawler = new CheerioCrawler({
        requestList: await RequestList.open(null, startUrls),
        maxConcurrency: 1,
        maxRequestsPerMinute: 10,
        requestHandlerTimeoutSecs: 60,

        requestHandler: async ({ $, request, enqueueLinks }) => {
            const { label } = request.userData;

            if (label === 'BRAND_DETAIL') {
                console.log(`Scraping brand details from ${request.url}`);
                
                const jsonLdScripts = $('script[type="application/ld+json"]')
                    .map((_, el) => {
                        try {
                            return JSON.parse($(el).html());
                        } catch (e) {
                            return null;
                        }
                    })
                    .get()
                    .filter(Boolean);

                let brandData = {
                    url: request.url,
                    name: null,
                    logo: null,
                    offers: []
                };

                for (const script of jsonLdScripts) {
                    if (script['@type'] === 'Organization') {
                        brandData.name = script.name;
                        brandData.logo = script.logo;
                    }
                    if (script['@type'] === 'ItemList') {
                        brandData.offers = await Promise.all(script.itemListElement?.map(async (item, index) => {
                            await new Promise(resolve => setTimeout(resolve, index * 2000));

                            const offerData = {
                                name: item.item?.name,
                                description: item.item?.description,
                                validFrom: item.item?.validFrom,
                                url: item.item?.url,
                                couponCode: null
                            };

                            console.log('Looking for offer with name:', offerData.name);

                            // First log all articles and their titles for debugging
                            $('article.Offer').each((_, article) => {
                                const title = $(article).find('h3.text-lg').text().trim();
                            });

                            // Find the specific article that contains this offer
                            let matchingArticle = null;
                            $('article.Offer').each((_, article) => {
                                const articleTitle = $(article).find('h3.text-lg').text().trim();
                                // Remove "Verificat" prefix if it exists and compare
                                const normalizedArticleTitle = articleTitle.replace('Verificat ', '');
                                if (normalizedArticleTitle === offerData.name) {
                                    matchingArticle = article;
                                    return false; // Break the loop when found
                                }
                            });

                            if (matchingArticle) {
                                console.log('Found matching article for:', offerData.name);
                                
                                // Search for the button within this specific article
                                const $article = $(matchingArticle);
                                // Look for the button using the exact structure
                                const button = $article.find('.OutlinkCta span:contains("Obțineți codul")').first();
                                const hasButton = button.length > 0;
                                
                                if (hasButton && offerData.url) {
                                    try {
                                        console.log(`Found button for offer: ${offerData.name}`);
                                        console.log(`Fetching coupon from URL: ${offerData.url}`);
                                        
                                        // Add delay before fetching
                                        await new Promise(resolve => setTimeout(resolve, 2000));

                                        // Enhanced headers and fetch options
                                        const response = await fetch(offerData.url, {
                                            method: 'GET',
                                            headers: {
                                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                                                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                                                'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
                                                'Accept-Encoding': 'gzip, deflate, br',
                                                'Connection': 'keep-alive',
                                                'Upgrade-Insecure-Requests': '1',
                                                'Sec-Fetch-Dest': 'document',
                                                'Sec-Fetch-Mode': 'navigate',
                                                'Sec-Fetch-Site': 'none',
                                                'Sec-Fetch-User': '?1',
                                                'Cache-Control': 'max-age=0',
                                                'Referer': 'https://www.lovecoupons.ro/',
                                            },
                                            redirect: 'follow',
                                            follow: 20,
                                            timeout: 30000,
                                            compress: true,
                                            credentials: 'include'
                                        });

                                        if (!response.ok) {
                                            throw new Error(`HTTP error! status: ${response.status}`);
                                        }

                                        const html = await response.text();
                                        console.log('Response URL:', response.url);
                                        console.log('Response status:', response.status);
                                        
                                        // Check if we got the Cloudflare page
                                        if (html.includes('Just a moment...')) {
                                            console.log('Got Cloudflare protection page');
                                            throw new Error('Cloudflare protection detected');
                                        }

                                        const $codePage = cheerio.load(html);
                                        
                                        // Try multiple selectors for the coupon code
                                        let couponCode = null;
                                        
                                        // Try the RevealCoupon input
                                        const revealCouponInput = $codePage('.RevealCoupon input[type="text"]').first();
                                        if (revealCouponInput.length > 0) {
                                            couponCode = revealCouponInput.val() || revealCouponInput.attr('value');
                                        }
                                        
                                        // Try the direct coupon input
                                        if (!couponCode) {
                                            const directCouponInput = $codePage('input[id^="coupon-"]').first();
                                            if (directCouponInput.length > 0) {
                                                couponCode = directCouponInput.val() || directCouponInput.attr('value');
                                            }
                                        }

                                        if (couponCode) {
                                            offerData.couponCode = couponCode;
                                            console.log(`Successfully found coupon code: ${couponCode}`);
                                        } else {
                                            console.log('No coupon input found on page');
                                            console.log('Page title:', $codePage('title').text());
                                            console.log('Available inputs:', $codePage('input').length);
                                        }

                                    } catch (error) {
                                        console.error('Error fetching coupon:', error.message);
                                    }
                                } else {
                                    console.log('No button found or no URL available');
                                }
                            } else {
                                console.log('No matching article found for:', offerData.name);
                            }

                            return offerData;
                        })) || [];
                    }
                }

                if (brandData.name || brandData.offers.length > 0) {
                    await Actor.pushData(brandData);
                    console.log(`Saved data for: ${brandData.name || request.url}`);
                }
            }
        },
        maxRequestRetries: 3,
        navigationTimeoutSecs: 30,
        preNavigationHooks: [
            async ({ request }) => {
                if (request.userData.delay) {
                    await new Promise(resolve => setTimeout(resolve, request.userData.delay));
                }

                request.headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'DNT': '1',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                };
            },
        ],
    });

    await crawler.run();
    await Actor.exit();
}

main();
