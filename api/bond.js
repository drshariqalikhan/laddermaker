// api/bonds.js
export default async function handler(req, res) {
  // Allow your PWA to read this endpoint cleanly
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  try {
    // Official MAS API endpoint querying the 10 most recent daily benchmark yield updates
    const masApiUrl = 'https://mas.gov.sg';
    
    const response = await fetch(masApiUrl);
    if (!response.ok) throw new Error('Failed to capture MAS payload');
    
    const data = await response.json();
    const records = data.result.records;

    if (!records || records.length === 0) {
      return res.status(404).json({ error: 'No active bond rows returned.' });
    }

    // Map the complex MAS data matrix into clean rows for our Bulma front-end
    const latestRecord = records[0]; 
    const structuredCurve = [
      { code: 'BS26120W', maturity: '6-Month', yield: parseFloat(latestRecord['comp_sgs_6m_tb_yield'] || 0) },
      { code: 'BY26103X', maturity: '1-Year', yield: parseFloat(latestRecord['comp_sgs_1y_tb_yield'] || 0) },
      { code: 'N523100W', maturity: '2-Year', yield: parseFloat(latestRecord['comp_sgs_2y_grant_yield'] || 0) },
      { code: 'N523100W', maturity: '5-Year', yield: parseFloat(latestRecord['comp_sgs_5y_grant_yield'] || 0) },
      { code: 'NX21100N', maturity: '10-Year', yield: parseFloat(latestRecord['comp_sgs_10y_grant_yield'] || 0) },
      { code: 'NZ16100X', maturity: '15-Year', yield: parseFloat(latestRecord['comp_sgs_15y_grant_yield'] || 0) },
      { code: 'NY25200N', maturity: '20-Year', yield: parseFloat(latestRecord['comp_sgs_20y_grant_yield'] || 0) },
      { code: 'NZ26300E', maturity: '30-Year', yield: parseFloat(latestRecord['comp_sgs_30y_grant_yield'] || 0) },
      { code: 'NA24300E', maturity: '50-Year', yield: parseFloat(latestRecord['comp_sgs_50y_grant_yield'] || 0) }
    ];

    return res.status(200).json({
      date: latestRecord['end_of_day'],
      curve: structuredCurve
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
