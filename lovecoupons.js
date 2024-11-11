import { Actor } from 'apify';
import puppeteer from "puppeteer";
import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();	
const { Client } = pkg; 

// Configurația PostgreSQL
const client = new Client({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,           
});

await client.connect(); // Conectare la baza de date

const brandUrls = []; 

function delay(time) {
    return new Promise(function(resolve) {
      setTimeout(resolve, time);
    });
}

async function collectBrandUrls(page) {
    const alphabet = ['0-9'];
    const baseURL = 'https://www.lovecoupons.ro/brands/';
    
    for (const letter of alphabet) {
        const url = `${baseURL}${letter === '0-9' ? '' : letter}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const urls = await page.evaluate(() => {
            const brandContainer = document.querySelector('ul.grid.grid-cols-1.sm\\:grid-cols-2.lg\\:grid-cols-3.gap-3');
            if (brandContainer) {
                return Array.from(brandContainer.querySelectorAll('a')).map(link => link.href);
            }
            return [];
        });

        brandUrls.push(...urls);
        console.log(`I have collected ${urls.length} urls for category ${letter.toUpperCase()}`);
    }

    console.log('All collected urls:', brandUrls);
    return brandUrls;
}

async function scrapeBrandDetails(page, brandUrls) {
    const results = [];

    for (const url of brandUrls) {
        try {
            await delay(1000);
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            const pageData = await page.evaluate(() => {
                const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                
                let offersData = [];
                let orgData = {
                    name: null,
                    logo: null,
                };

                scripts.forEach(script => {
                    try {
                        const jsonData = JSON.parse(script.innerText);
                        if (jsonData['@type'] === 'ItemList' && jsonData.itemListElement) {
                            offersData = jsonData.itemListElement.map(item => ({
                                name: item.item?.name || null,
                                url: item.item?.url || null,
                                description: item.item?.description || null,
                                validFrom: item.item?.validFrom || null,
                            }));
                        } else if (jsonData['@type'] === 'Organization') {
                            orgData.name = jsonData.name || null;
                            orgData.logo = jsonData.logo || null;
                        }
                    } catch (error) {
                        console.log('Error parsing JSON-LD:', error);
                    }
                });

                return { offersData, orgData };
            });

            results.push({
                brand: pageData.orgData.name,
                logo: pageData.orgData.logo,
                offers: pageData.offersData.map(offer => ({
                    name: offer.name,
                    url: offer.url,
                    description: offer.description,
                    validFrom: offer.validFrom,
                })),
            });
            console.log(`Pushed items for:  ${url}`)
        } catch (error) {
            console.log(`Error scraping ${url}:`, error);
        }
    }

    console.log('Scraping completed. Data collected:', results);
    return results;
}

async function saveToDatabase(data) {
    
    await client.query(`
        CREATE TABLE IF NOT EXISTS brands (
            id SERIAL PRIMARY KEY,
            brand_name VARCHAR(255),
            logo VARCHAR(255)
        );
    `);

    await client.query(`
        CREATE TABLE IF NOT EXISTS offers (
            id SERIAL PRIMARY KEY,
            brand_id INTEGER REFERENCES brands(id),
            offer_name VARCHAR(255),
            url TEXT,
            description TEXT,
            valid_from DATE
        );
    `);

    for (const brand of data) {
        const brandResult = await client.query(
            `INSERT INTO brands (brand_name, logo) VALUES ($1, $2) RETURNING id`,
            [brand.brand, brand.logo]
        );
        const brandId = brandResult.rows[0].id;

        for (const offer of brand.offers) {
            await client.query(
                `INSERT INTO offers (brand_id, offer_name, url, description, valid_from) VALUES ($1, $2, $3, $4, $5)`,
                [brandId, offer.name, offer.url, offer.description, offer.validFrom]
            );
        }
    }
    console.log("Data saved to PostgreSQL database.");
}


await Actor.init(); 
(async () => {
    const browser = await puppeteer.launch({ headless: true,  args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();

    try {
        
        const brandUrls = await collectBrandUrls(page);
        console.log(`I have collected a total of ${brandUrls.length} brand links.`);

      
        const data = await scrapeBrandDetails(page, brandUrls);
        console.log('Collected data:', data);

        
        await saveToDatabase(data);
    } finally {
        await browser.close();
        console.log('Browser closed.');
        await client.end(); 
    }
})();
await Actor.exit(); 
