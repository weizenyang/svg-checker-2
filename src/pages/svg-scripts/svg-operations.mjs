function checkSVG(svgContainer){
    const svg = svgContainer.querySelector("svg")
    if(svg.length > 0){
        return {exist: false, container: null}
    }

    return {exist: true, container: svg}
}